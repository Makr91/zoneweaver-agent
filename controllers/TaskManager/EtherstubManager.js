import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import { parseAsync } from '../../lib/AsyncJson.js';
import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import NetworkUsage from '../../models/NetworkUsageModel.js';
import os from 'os';

/**
 * Etherstub Manager for Virtual Switch Operations
 * Handles etherstub creation and deletion
 */

/**
 * Execute etherstub creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeCreateEtherstubTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name, temporary } = metadata;

    let command = `pfexec dladm create-etherstub`;
    if (temporary) {
      command += ` -t`;
    }
    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Etherstub ${name} created successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to create etherstub ${name}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Etherstub creation task failed: ${error.message}` };
  }
};

/**
 * Execute etherstub deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDeleteEtherstubTask = async metadataJson => {
  log.task.debug('Etherstub deletion task starting');

  try {
    const metadata = await parseAsync(metadataJson);
    const { etherstub, temporary, force } = metadata;

    log.task.debug('Etherstub deletion task parameters', {
      etherstub,
      temporary,
      force,
    });

    // If force deletion, first remove any VNICs on the etherstub
    if (force) {
      log.task.debug('Force deletion enabled, checking for VNICs on etherstub');
      const vnicResult = await executeCommand(`pfexec dladm show-vnic -l ${etherstub} -p -o link`);
      if (vnicResult.success && vnicResult.output.trim()) {
        const vnics = vnicResult.output.trim().split('\n');
        log.task.debug('Found VNICs to remove', {
          count: vnics.length,
          vnics: vnics.join(', '),
        });
        await Promise.all(
          vnics.map(vnic => {
            log.task.debug('Removing VNIC from etherstub', { vnic });
            return executeCommand(`pfexec dladm delete-vnic ${temporary ? '-t' : ''} ${vnic}`);
          })
        );
      } else {
        log.task.debug('No VNICs found on etherstub');
      }
    }

    let command = `pfexec dladm delete-etherstub`;
    if (temporary) {
      command += ` -t`;
    }
    command += ` ${etherstub}`;

    log.task.debug('Executing etherstub deletion command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.debug('Etherstub deleted from system, cleaning up database');

      const hostname = os.hostname();
      const cleanupResults = {
        network_interfaces: 0,
        network_stats: 0,
        network_usage: 0,
      };

      try {
        const interfacesDeleted = await NetworkInterfaces.destroy({
          where: {
            host: hostname,
            link: etherstub,
            class: 'etherstub',
          },
        });
        cleanupResults.network_interfaces = interfacesDeleted;
        log.task.debug('Cleaned up network interface entries', {
          deleted_count: interfacesDeleted,
          etherstub,
        });

        const usageDeleted = await NetworkUsage.destroy({
          where: {
            host: hostname,
            link: etherstub,
          },
        });
        cleanupResults.network_usage = usageDeleted;
        log.task.debug('Cleaned up network usage entries', {
          deleted_count: usageDeleted,
          etherstub,
        });

        const totalCleaned =
          cleanupResults.network_interfaces +
          cleanupResults.network_stats +
          cleanupResults.network_usage;
        log.task.info('Database cleanup completed for etherstub', {
          total_cleaned: totalCleaned,
          etherstub,
        });

        return {
          success: true,
          message: `Etherstub ${etherstub} deleted successfully (system + ${totalCleaned} database entries cleaned)`,
          cleanup_summary: cleanupResults,
        };
      } catch (cleanupError) {
        log.task.warn('Etherstub deleted but database cleanup failed', {
          etherstub,
          error: cleanupError.message,
        });
        return {
          success: true,
          message: `Etherstub ${etherstub} deleted successfully (warning: database cleanup failed - ${cleanupError.message})`,
          cleanup_error: cleanupError.message,
        };
      }
    } else {
      log.task.error('Etherstub deletion command failed', {
        etherstub,
        error: result.error,
      });
      return {
        success: false,
        error: `Failed to delete etherstub ${etherstub}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('Etherstub deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Etherstub deletion task failed: ${error.message}` };
  }
};
