/**
 * @fileoverview Zone Deletion Task Executor for Zoneweaver Agent
 * @description Executes zone delete tasks with optional ZFS dataset and networking cleanup.
 */
import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import { parseAsync } from '../../../lib/AsyncJson.js';
import Tasks from '../../../models/TaskModel.js';
import Zones from '../../../models/ZoneModel.js';
import NetworkInterfaces from '../../../models/NetworkInterfaceModel.js';
import NetworkUsage from '../../../models/NetworkUsageModel.js';
import IPAddresses from '../../../models/IPAddressModel.js';
import { executeDeleteVNICTask } from '../VNICManager.js';
import { executeDeleteIPAddressTask } from '../NetworkManager.js';
import { Op } from 'sequelize';
import { terminateVncSession } from './ZoneLifecycleTasks.js';
import { extractZoneDatasets, cleanupZoneDatasets } from './ZoneDatasetCleanup.js';

/**
 * Parse delete task metadata
 * @param {string} metadataJson - JSON metadata string
 * @returns {Promise<{cleanupDatasets: boolean, cleanupNetworking: boolean}>}
 */
const parseDeleteMetadata = async metadataJson => {
  let cleanupDatasets = false;
  let cleanupNetworking = false;
  if (metadataJson) {
    try {
      const metadata = await parseAsync(metadataJson);
      cleanupDatasets = metadata.cleanup_disks === true;
      cleanupNetworking = metadata.cleanup_networking === true;
    } catch {
      // Ignore metadata parse errors - proceed without cleanup
    }
  }
  return { cleanupDatasets, cleanupNetworking };
};

/**
 * Execute zone delete task
 * @param {string} zoneName - Name of zone to delete
 * @param {string} [metadataJson] - Optional JSON metadata string with cleanup options
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDeleteTask = async (zoneName, metadataJson) => {
  try {
    const { cleanupDatasets, cleanupNetworking } = await parseDeleteMetadata(metadataJson);

    // Collect dataset info before deleting the zone config
    let zoneDatasets = { zonepath: null, datasets: [] };
    if (cleanupDatasets) {
      zoneDatasets = await extractZoneDatasets(zoneName);
      log.task.info('Collected ZFS datasets for cleanup', {
        zone_name: zoneName,
        datasets: zoneDatasets.datasets,
      });
    }

    // Terminate VNC session if active
    await terminateVncSession(zoneName);

    // Stop zone if running
    await executeCommand(`pfexec zoneadm -z ${zoneName} halt`);

    // Uninstall zone
    const uninstallResult = await executeCommand(`pfexec zoneadm -z ${zoneName} uninstall -F`);

    if (!uninstallResult.success) {
      return {
        success: false,
        error: `Failed to uninstall zone ${zoneName}: ${uninstallResult.error}`,
      };
    }

    // Delete zone configuration
    const deleteResult = await executeCommand(`pfexec zonecfg -z ${zoneName} delete -F`);

    if (!deleteResult.success) {
      return {
        success: false,
        error: `Failed to delete zone configuration ${zoneName}: ${deleteResult.error}`,
      };
    }

    // Clean up ZFS datasets if requested (ownership-gated: only stamped
    // datasets die; skips are narrated, never silent)
    let datasetErrors = [];
    let datasetSkipped = [];
    if (cleanupDatasets && zoneDatasets.datasets.length > 0) {
      const cleanup = await cleanupZoneDatasets(zoneName, zoneDatasets);
      datasetErrors = cleanup.errors;
      datasetSkipped = cleanup.skipped;

      if (datasetErrors.length > 0) {
        log.task.warn('Some ZFS datasets could not be cleaned up', {
          zone_name: zoneName,
          errors: datasetErrors,
        });

        return {
          success: false,
          error: `Zone deleted but ZFS cleanup failed: ${datasetErrors.join('; ')}`,
        };
      }
    }

    // Handle Network Cleanup
    // Find all interfaces associated with this zone
    const zoneInterfaces = await NetworkInterfaces.findAll({ where: { zone: zoneName } });

    if (cleanupNetworking) {
      log.task.info('Cleaning up network resources for zone', {
        zone_name: zoneName,
        count: zoneInterfaces.length,
      });

      await Promise.all(
        zoneInterfaces.map(async iface => {
          // 1. Delete IPs associated with this interface
          const ips = await IPAddresses.findAll({ where: { interface: iface.link } });
          await Promise.all(
            ips.map(ip =>
              executeDeleteIPAddressTask(JSON.stringify({ addrobj: ip.addrobj, release: true }))
            )
          );

          // 2. Delete VNIC if it is a VNIC
          if (iface.class === 'vnic') {
            await executeDeleteVNICTask(JSON.stringify({ vnic: iface.link }));
          } else {
            // For physical/other interfaces, just dissociate
            await iface.update({ zone: null });
          }
        })
      );
    } else if (zoneInterfaces.length > 0) {
      // Just dissociate interfaces from the zone
      log.task.info('Dissociating network interfaces from zone', {
        zone_name: zoneName,
        count: zoneInterfaces.length,
      });
      await NetworkInterfaces.update({ zone: null }, { where: { zone: zoneName } });
    }

    // Clean up all database entries in parallel
    await Promise.all([
      // Remove zone from database
      Zones.destroy({ where: { name: zoneName } }),

      // Clean up orphaned usage/IP records that might have been missed by manager tasks
      // (Only if they match the strict naming convention, as a fallback)
      NetworkUsage.destroy({ where: { link: { [Op.like]: `${zoneName}%` } } }),
      IPAddresses.destroy({ where: { interface: { [Op.like]: `${zoneName}%` } } }),

      // Clean up any remaining tasks for this zone
      Tasks.update(
        { status: 'cancelled' },
        {
          where: {
            zone_name: zoneName,
            status: 'pending',
          },
        }
      ),
    ]);

    let message = `Zone ${zoneName} deleted successfully`;
    if (cleanupDatasets) {
      if (datasetErrors.length === 0) {
        message += ' (ZFS datasets cleaned up)';
      } else {
        message += ` (${datasetErrors.length} ZFS dataset cleanup errors)`;
      }
      if (datasetSkipped.length > 0) {
        message += ` — ${datasetSkipped.length} dataset(s) skipped, not stamped ours`;
      }
    }

    return {
      success: true,
      message,
      dataset_errors: datasetErrors.length > 0 ? datasetErrors : undefined,
      skipped_datasets: datasetSkipped.length > 0 ? datasetSkipped : undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to delete zone ${zoneName}: ${error.message}`,
    };
  }
};
