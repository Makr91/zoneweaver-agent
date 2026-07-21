import { parseAsync } from '../../lib/AsyncJson.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import NetworkUsage from '../../models/NetworkUsageModel.js';
import os from 'os';

/**
 * Bridge Manager for Bridge Operations
 * Handles bridge creation, deletion, and link modification
 */

/**
 * Execute bridge creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeCreateBridgeTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const {
      name,
      protection,
      priority,
      max_age,
      hello_time,
      forward_delay,
      force_protocol,
      links,
    } = metadata;

    let command = `pfexec dladm create-bridge`;

    // Add protection
    if (protection && protection !== 'stp') {
      command += ` -P ${protection}`;
    }

    // Add priority
    if (priority && priority !== 32768) {
      command += ` -p ${priority}`;
    }

    // Add timing parameters
    if (max_age && max_age !== 20) {
      command += ` -m ${max_age}`;
    }
    if (hello_time && hello_time !== 2) {
      command += ` -h ${hello_time}`;
    }
    if (forward_delay && forward_delay !== 15) {
      command += ` -d ${forward_delay}`;
    }

    // Add force protocol
    if (force_protocol && force_protocol !== 3) {
      command += ` -f ${force_protocol}`;
    }

    // Add links
    if (links && links.length > 0) {
      for (const link of links) {
        command += ` -l ${link}`;
      }
    }

    // Add bridge name
    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Bridge ${name} created successfully${links && links.length > 0 ? ` with links: ${links.join(', ')}` : ''}`,
      };
    }
    return {
      success: false,
      error: `Failed to create bridge ${name}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Bridge creation task failed: ${error.message}` };
  }
};

/**
 * Execute bridge deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDeleteBridgeTask = async metadataJson => {
  log.task.debug('Bridge deletion task starting');

  try {
    const metadata = await parseAsync(metadataJson);
    const { bridge, force } = metadata;

    log.task.debug('Bridge deletion task parameters', {
      bridge,
      force,
    });

    // If force deletion, first remove any attached links
    if (force) {
      log.task.debug('Force deletion enabled, checking for attached links');
      const linksResult = await executeCommand(`pfexec dladm show-bridge ${bridge} -l -p -o link`);
      if (linksResult.success && linksResult.output.trim()) {
        const attachedLinks = linksResult.output.trim().split('\n');
        log.task.debug('Found attached links to remove', {
          count: attachedLinks.length,
          links: attachedLinks.join(', '),
        });
        await Promise.all(
          attachedLinks.map(link => {
            log.task.debug('Removing link from bridge', { link, bridge });
            return executeCommand(`pfexec dladm remove-bridge -l ${link} ${bridge}`);
          })
        );
      } else {
        log.task.debug('No attached links found on bridge');
      }
    }

    log.task.debug('Executing bridge deletion command');
    const result = await executeCommand(`pfexec dladm delete-bridge ${bridge}`);

    if (result.success) {
      log.task.debug('Bridge deleted from system, cleaning up database');

      // Clean up all monitoring database entries for this bridge
      const hostname = os.hostname();
      const cleanupResults = {
        network_interfaces: 0,
        network_stats: 0,
        network_usage: 0,
      };

      try {
        // Clean up NetworkInterfaces table (monitoring data)
        const interfacesDeleted = await NetworkInterfaces.destroy({
          where: {
            host: hostname,
            link: bridge,
            class: 'bridge',
          },
        });
        cleanupResults.network_interfaces = interfacesDeleted;
        log.task.debug('Cleaned up network interface entries', {
          deleted_count: interfacesDeleted,
          bridge,
        });

        // Clean up NetworkUsage table (usage accounting)
        const usageDeleted = await NetworkUsage.destroy({
          where: {
            host: hostname,
            link: bridge,
          },
        });
        cleanupResults.network_usage = usageDeleted;
        log.task.debug('Cleaned up network usage entries', {
          deleted_count: usageDeleted,
          bridge,
        });

        const totalCleaned =
          cleanupResults.network_interfaces +
          cleanupResults.network_stats +
          cleanupResults.network_usage;
        log.task.info('Database cleanup completed for bridge', {
          total_cleaned: totalCleaned,
          bridge,
        });

        return {
          success: true,
          message: `Bridge ${bridge} deleted successfully (system + ${totalCleaned} database entries cleaned)`,
          cleanup_summary: cleanupResults,
        };
      } catch (cleanupError) {
        log.task.warn('Bridge deleted but database cleanup failed', {
          bridge,
          error: cleanupError.message,
        });
        return {
          success: true,
          message: `Bridge ${bridge} deleted successfully (warning: database cleanup failed - ${cleanupError.message})`,
          cleanup_error: cleanupError.message,
        };
      }
    } else {
      log.task.error('Bridge deletion command failed', {
        bridge,
        error: result.error,
      });
      return {
        success: false,
        error: `Failed to delete bridge ${bridge}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('Bridge deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Bridge deletion task failed: ${error.message}` };
  }
};

/**
 * Execute bridge links modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeModifyBridgeLinksTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { bridge, operation, links } = metadata;

    let command = `pfexec dladm ${operation}-bridge`;

    // Add links
    for (const link of links) {
      command += ` -l ${link}`;
    }

    // Add bridge name
    command += ` ${bridge}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Successfully ${operation}ed links ${links.join(', ')} ${operation === 'add' ? 'to' : 'from'} bridge ${bridge}`,
      };
    }
    return {
      success: false,
      error: `Failed to ${operation} links on bridge ${bridge}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Bridge links modification task failed: ${error.message}` };
  }
};
