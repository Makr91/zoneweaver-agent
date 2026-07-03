/**
 * @fileoverview Zone Lifecycle Manager for Zoneweaver Agent
 * @description Executes zone lifecycle operations: start, stop, restart, delete, discover with dataset cleanup.
 * CRITICAL: NO BACKWARD COMPATIBILITY - Hosts.yml structure ONLY (settings/zones/networks/disks/provisioner)
 */
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import {
  getAllZoneConfigs,
  syncZoneToDatabase,
  preserveUserConfig,
} from '../../lib/ZoneConfigUtils.js';
import yj from 'yieldable-json';
import Tasks from '../../models/TaskModel.js';
import Zones from '../../models/ZoneModel.js';
import VncSessions from '../../models/VncSessionModel.js';
import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import NetworkUsage from '../../models/NetworkUsageModel.js';
import IPAddresses from '../../models/IPAddressModel.js';
import { executeDeleteVNICTask } from './VNICManager.js';
import { executeDeleteIPAddressTask } from './NetworkManager.js';
import { Op } from 'sequelize';
import os from 'os';

/**
 * Zone Manager for Zone Lifecycle Operations
 * Handles zone start, stop, restart, delete, discover operations and VNC session termination
 */

/**
 * Terminate VNC session for a zone
 * @param {string} zoneName - Name of zone
 */
const terminateVncSession = async zoneName => {
  try {
    const session = await VncSessions.findOne({
      where: { zone_name: zoneName, status: 'active' },
    });

    if (session && session.process_id) {
      try {
        process.kill(session.process_id, 'SIGTERM');
      } catch (error) {
        log.task.warn('Failed to kill VNC process', {
          zone_name: zoneName,
          process_id: session.process_id,
          error: error.message,
        });
      }

      await session.update({ status: 'stopped' });
    }
  } catch (error) {
    log.task.warn('Failed to terminate VNC session', {
      zone_name: zoneName,
      error: error.message,
    });
  }
};

/**
 * Execute zone start task
 * @param {string} zoneName - Name of zone to start
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeStartTask = async zoneName => {
  const result = await executeCommand(`pfexec zoneadm -z ${zoneName} boot`);

  if (result.success) {
    // Fix zonepath permissions after boot (zoneadm resets to 700)
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (zone) {
      let zoneConfig = zone.configuration;
      if (typeof zoneConfig === 'string') {
        try {
          zoneConfig = JSON.parse(zoneConfig);
        } catch (e) {
          log.task.warn('Failed to parse zone configuration', { error: e.message });
        }
      }
      const zonepath = zoneConfig?.zonepath;
      if (zonepath) {
        const chmodResult = await executeCommand(`pfexec chmod 755 ${zonepath}`);
        if (!chmodResult.success) {
          log.task.warn('Failed to set zonepath permissions after boot', {
            zonepath,
            error: chmodResult.error,
          });
        }
      }
    }

    // Update zone status in database
    await Zones.update(
      {
        status: 'running',
        last_seen: new Date(),
        is_orphaned: false,
      },
      { where: { name: zoneName } }
    );

    return {
      success: true,
      message: `Zone ${zoneName} started successfully`,
    };
  }
  return {
    success: false,
    error: `Failed to start zone ${zoneName}: ${result.error}`,
  };
};

/**
 * Execute zone stop task
 * @param {string} zoneName - Name of zone to stop
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeStopTask = async zoneName => {
  // First try graceful shutdown
  let result = await executeCommand(`pfexec zoneadm -z ${zoneName} shutdown`);

  // If graceful shutdown fails, try halt
  if (!result.success) {
    result = await executeCommand(`pfexec zoneadm -z ${zoneName} halt`);
  }

  if (result.success) {
    // Update zone status in database
    await Zones.update(
      {
        status: 'installed',
        last_seen: new Date(),
      },
      { where: { name: zoneName } }
    );

    // Terminate any active VNC sessions for this zone
    await terminateVncSession(zoneName);

    return {
      success: true,
      message: `Zone ${zoneName} stopped successfully`,
    };
  }
  return {
    success: false,
    error: `Failed to stop zone ${zoneName}: ${result.error}`,
  };
};

/**
 * Execute zone restart task
 * @param {string} zoneName - Name of zone to restart
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRestartTask = async zoneName => {
  // Stop first
  const stopResult = await executeStopTask(zoneName);
  if (!stopResult.success) {
    return stopResult;
  }

  // Wait a moment for clean shutdown
  await new Promise(resolve => {
    setTimeout(resolve, 2000);
  });

  // Then start
  return executeStartTask(zoneName);
};

/**
 * Fetches and parses the zone configuration, with a self-healing fallback.
 * @param {string} zoneName - The name of the zone.
 * @returns {Promise<Object|null>} The parsed zone configuration or null on failure.
 */
const getZoneConfigurationForCleanup = async zoneName => {
  try {
    const zone = await Zones.findOne({ where: { name: zoneName } });
    let zoneConfig = zone?.configuration;

    if (typeof zoneConfig === 'string') {
      try {
        zoneConfig = JSON.parse(zoneConfig);
      } catch (parseErr) {
        log.task.error('Failed to parse zone configuration string', {
          zone_name: zoneName,
          error: parseErr.message,
        });
        return null; // Unusable config
      }
    }

    if (!zoneConfig) {
      log.task.info('Zone not found in DB, attempting to sync from system for cleanup', {
        zone_name: zoneName,
      });
      const newZone = await syncZoneToDatabase(zoneName);
      zoneConfig = newZone.configuration;
    }
    return zoneConfig;
  } catch (error) {
    log.task.warn('Could not get zone configuration for cleanup', {
      zone_name: zoneName,
      error: error.message,
    });
    return null;
  }
};

/**
 * Helper to collect datasets from zonepath
 * @param {Object} zoneConfig - Zone configuration
 * @param {Set<string>} potentialDatasets - Set to add datasets to
 */
const collectZonepathDatasets = (zoneConfig, potentialDatasets) => {
  if (zoneConfig.zonepath) {
    let candidateDataset = zoneConfig.zonepath.startsWith('/')
      ? zoneConfig.zonepath.substring(1)
      : zoneConfig.zonepath;
    if (candidateDataset.endsWith('/path')) {
      candidateDataset = candidateDataset.substring(0, candidateDataset.length - 5);
    }
    potentialDatasets.add(candidateDataset);
  }
};

/**
 * Helper to collect datasets from bootdisk
 * @param {Object} zoneConfig - Zone configuration
 * @param {Set<string>} potentialDatasets - Set to add datasets to
 */
const collectBootdiskDatasets = (zoneConfig, potentialDatasets) => {
  if (zoneConfig.bootdisk?.path) {
    potentialDatasets.add(zoneConfig.bootdisk.path);
    const parts = zoneConfig.bootdisk.path.split('/');
    if (parts.length > 1) {
      potentialDatasets.add(parts.slice(0, -1).join('/'));
    }
  }
};

/**
 * Helper to collect datasets from disks and legacy attributes
 * @param {Object} zoneConfig - Zone configuration
 * @param {Set<string>} potentialDatasets - Set to add datasets to
 */
const collectDiskDatasets = (zoneConfig, potentialDatasets) => {
  // Additional Disks
  if (zoneConfig.disk) {
    const disks = Array.isArray(zoneConfig.disk) ? zoneConfig.disk : [zoneConfig.disk];
    for (const disk of disks) {
      if (disk.path) {
        potentialDatasets.add(disk.path);
      }
    }
  }

  // Legacy disk attributes
  if (zoneConfig.attr) {
    const attrs = Array.isArray(zoneConfig.attr) ? zoneConfig.attr : [zoneConfig.attr];
    for (const attr of attrs) {
      if (attr.name && /^disk\d+$/.test(attr.name) && attr.value) {
        potentialDatasets.add(attr.value);
      }
    }
  }
};

/**
 * Helper to collect datasets from devices, filesystems, and explicit datasets
 * @param {Object} zoneConfig - Zone configuration
 * @param {Set<string>} potentialDatasets - Set to add datasets to
 */
const collectMiscDatasets = (zoneConfig, potentialDatasets) => {
  // ZVOL devices
  if (zoneConfig.device) {
    const devices = Array.isArray(zoneConfig.device) ? zoneConfig.device : [zoneConfig.device];
    for (const dev of devices) {
      if (dev.match) {
        const match = dev.match.match(/\/dev\/zvol\/(?:r)?dsk\/(?<dataset>.+)/);
        if (match?.groups?.dataset) {
          potentialDatasets.add(match.groups.dataset);
        }
      }
    }
  }

  // Filesystems
  if (zoneConfig.fs) {
    const fss = Array.isArray(zoneConfig.fs) ? zoneConfig.fs : [zoneConfig.fs];
    for (const fs of fss) {
      if (fs.special) {
        if (!fs.special.startsWith('/')) {
          potentialDatasets.add(fs.special);
        } else {
          const match = fs.special.match(/\/dev\/zvol\/(?:r)?dsk\/(?<dataset>.+)/);
          if (match?.groups?.dataset) {
            potentialDatasets.add(match.groups.dataset);
          }
        }
      }
    }
  }

  // Explicit datasets
  if (zoneConfig.dataset) {
    const dss = Array.isArray(zoneConfig.dataset) ? zoneConfig.dataset : [zoneConfig.dataset];
    for (const ds of dss) {
      if (ds.name) {
        potentialDatasets.add(ds.name);
      }
    }
  }
};

/**
 * Collects all potential ZFS dataset paths from a zone's configuration.
 * @param {Object} zoneConfig - The parsed zone configuration.
 * @returns {Set<string>} A set of potential dataset paths.
 */
const collectPotentialDatasets = zoneConfig => {
  const potentialDatasets = new Set();
  collectZonepathDatasets(zoneConfig, potentialDatasets);
  collectBootdiskDatasets(zoneConfig, potentialDatasets);
  collectDiskDatasets(zoneConfig, potentialDatasets);
  collectMiscDatasets(zoneConfig, potentialDatasets);
  return potentialDatasets;
};

/**
 * Verifies the existence of potential datasets in parallel.
 * @param {Set<string>} potentialDatasets - A set of dataset names to verify.
 * @returns {Promise<string[]>} An array of dataset names that exist on the system.
 */
const verifyDatasets = async potentialDatasets => {
  const verificationPromises = Array.from(potentialDatasets).map(async ds => {
    try {
      // Suppress error logging for non-existent datasets using shell redirection
      const result = await executeCommand(`pfexec zfs list -H -o name "${ds}" 2>/dev/null || true`);
      if (result.success && result.output.trim()) {
        return result.output.trim();
      }
      return null;
    } catch (error) {
      log.task.debug('Dataset verification failed for potential dataset', {
        dataset: ds,
        error: error.message,
      });
      return null;
    }
  });

  const verified = await Promise.all(verificationPromises);
  return verified.filter(Boolean); // Filter out nulls
};

/**
 * Extract ZFS dataset paths from a zone configuration for cleanup
 * @param {string} zoneName - Name of zone
 * @returns {Promise<{zonepath: string|null, datasets: string[]}>}
 */
const extractZoneDatasets = async zoneName => {
  try {
    const zoneConfig = await getZoneConfigurationForCleanup(zoneName);

    if (!zoneConfig) {
      return { zonepath: null, datasets: [] };
    }

    const potentialDatasets = collectPotentialDatasets(zoneConfig);
    const datasets = await verifyDatasets(potentialDatasets);

    return { zonepath: zoneConfig.zonepath, datasets };
  } catch (error) {
    log.task.warn('Failed to extract zone datasets', {
      zone_name: zoneName,
      error: error.message,
    });
    return { zonepath: null, datasets: [] };
  }
};

/**
 * Get a set of datasets that are protected (used by other zones)
 * @param {string} excludeZoneName - The name of the zone being deleted
 * @returns {Promise<Set<string>>} Set of protected dataset paths
 */
const getProtectedDatasets = async excludeZoneName => {
  const protectedDatasets = new Set();
  try {
    const allZones = await getAllZoneConfigs();

    for (const [zoneName, config] of Object.entries(allZones)) {
      if (zoneName === excludeZoneName) {
        continue;
      }

      // Protect zonepath (and normalized dataset name)
      if (config.zonepath) {
        protectedDatasets.add(config.zonepath);
        // Normalize to dataset name (strip leading / and trailing /path)
        let dsName = config.zonepath.startsWith('/')
          ? config.zonepath.substring(1)
          : config.zonepath;
        if (dsName.endsWith('/path')) {
          dsName = dsName.substring(0, dsName.length - 5);
        }
        protectedDatasets.add(dsName);
      }

      // Protect bootdisk
      if (config.bootdisk?.path) {
        protectedDatasets.add(config.bootdisk.path);
      }

      // Protect disks
      if (config.disk) {
        const disks = Array.isArray(config.disk) ? config.disk : [config.disk];
        for (const disk of disks) {
          if (disk.path) {
            protectedDatasets.add(disk.path);
          }
        }
      }
      // Note: Legacy 'attr' disks are covered if they appear in 'disk' array (zadm handles this),
      // but we could add specific attr parsing if needed. zadm show usually normalizes this.
    }
  } catch (error) {
    log.task.warn('Failed to build protected datasets list', { error: error.message });
  }
  return protectedDatasets;
};

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
      const metadata = await new Promise((resolve, reject) => {
        yj.parseAsync(metadataJson, (err, parseResult) => {
          if (err) {
            reject(err);
          } else {
            resolve(parseResult);
          }
        });
      });
      cleanupDatasets = metadata.cleanup_datasets === true;
      cleanupNetworking = metadata.cleanup_networking === true;
    } catch {
      // Ignore metadata parse errors - proceed without cleanup
    }
  }
  return { cleanupDatasets, cleanupNetworking };
};

/**
 * Process single dataset for deletion with safety checks
 * @param {string} dataset - Dataset to destroy
 * @param {string} zoneName - Zone name
 * @param {Set} protectedDatasets - Protected datasets (Set)
 * @returns {Promise<string|null>} Error message or null if successful
 */
const processSingleDataset = async (dataset, zoneName, protectedDatasets) => {
  // Safety Check: Intersection with protected datasets
  const isProtected = Array.from(protectedDatasets).some(
    protectedDs =>
      dataset === protectedDs ||
      protectedDs.startsWith(`${dataset}/`) ||
      protectedDs.startsWith(`/${dataset}/`)
  );

  if (isProtected) {
    log.task.warn('Skipping protected dataset', { zone_name: zoneName, dataset });
    return null;
  }

  // Execute Safe Destroy
  const check = await executeCommand(`pfexec zfs list -H -o name "${dataset}" 2>/dev/null`);
  if (check.success) {
    const destroyResult = await executeCommand(`pfexec zfs destroy -r "${dataset}"`);
    if (!destroyResult.success) {
      return `Failed to destroy ${dataset}: ${destroyResult.error}`;
    }
    log.task.info('Destroyed ZFS dataset', { dataset });
  }
  return null;
};

/**
 * Clean up ZFS datasets for a zone
 * @param {string} zoneName - Name of the zone
 * @param {Object} zoneDatasets - Datasets to clean up
 * @returns {Promise<string[]>} Array of error messages
 */
const cleanupZoneDatasets = async (zoneName, zoneDatasets) => {
  const protectedDatasets = await getProtectedDatasets(zoneName);
  const sortedDatasets = [...zoneDatasets.datasets].sort((a, b) => a.length - b.length);

  const errors = await Promise.all(
    sortedDatasets.map(dataset => processSingleDataset(dataset, zoneName, protectedDatasets))
  );

  return errors.filter(Boolean);
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

    // Clean up ZFS datasets if requested
    let datasetErrors = [];
    if (cleanupDatasets && zoneDatasets.datasets.length > 0) {
      datasetErrors = await cleanupZoneDatasets(zoneName, zoneDatasets);

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
    }

    return {
      success: true,
      message,
      dataset_errors: datasetErrors.length > 0 ? datasetErrors : undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to delete zone ${zoneName}: ${error.message}`,
    };
  }
};

/**
 * Execute zone discovery task
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDiscoverTask = async () => {
  try {
    // Get all zones from system using zadm
    const systemZones = await getAllZoneConfigs();
    const systemZoneNames = Object.keys(systemZones);

    // Get all zones from database
    const dbZones = await Zones.findAll();
    const dbZoneNames = dbZones.map(z => z.name);

    let discovered = 0;
    let orphaned = 0;

    // Add new zones found on system but not in database
    const newZonesToCreate = systemZoneNames.filter(zoneName => !dbZoneNames.includes(zoneName));

    const createdZones = await Promise.all(
      newZonesToCreate.map(async zoneName => {
        const zoneConfig = systemZones[zoneName];

        // Get current status
        const statusResult = await executeCommand(`pfexec zoneadm -z ${zoneName} list -p`);
        let status = 'configured';
        if (statusResult.success) {
          const parts = statusResult.output.split(':');
          status = parts[2] || 'configured';
        }

        return Zones.create({
          name: zoneName,
          zone_id: zoneConfig.zonename || zoneName,
          host: os.hostname(),
          status,
          brand: zoneConfig.brand || 'unknown',
          configuration: zoneConfig,
          auto_discovered: true,
          last_seen: new Date(),
        });
      })
    );

    discovered = createdZones.length;

    // Process orphaned and existing zones in parallel
    const orphanedZones = dbZones.filter(dbZone => !systemZoneNames.includes(dbZone.name));
    const existingZones = dbZones.filter(dbZone => systemZoneNames.includes(dbZone.name));

    // Mark zones as orphaned in parallel
    await Promise.all(orphanedZones.map(dbZone => dbZone.update({ is_orphaned: true })));
    orphaned = orphanedZones.length;

    // Update existing zones in parallel
    await Promise.all(
      existingZones.map(async dbZone => {
        const zoneConfig = systemZones[dbZone.name];
        const statusResult = await executeCommand(`pfexec zoneadm -z ${dbZone.name} list -p`);
        let { status } = dbZone;
        if (statusResult.success) {
          const parts = statusResult.output.split(':');
          status = parts[2] || dbZone.status;
        }

        // Preserve user-defined config sections (settings, zones, networks, disks, provisioner)
        preserveUserConfig(dbZone, zoneConfig, dbZone.name);

        return dbZone.update({
          status,
          brand: zoneConfig.brand || dbZone.brand,
          configuration: zoneConfig,
          last_seen: new Date(),
          is_orphaned: false,
        });
      })
    );

    return {
      success: true,
      message: `Discovery completed: ${discovered} new zones discovered, ${orphaned} zones orphaned`,
    };
  } catch (error) {
    return {
      success: false,
      error: `Zone discovery failed: ${error.message}`,
    };
  }
};
