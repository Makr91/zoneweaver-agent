import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import { parseAsync } from '../../lib/AsyncJson.js';
import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import NetworkUsage from '../../models/NetworkUsageModel.js';
import os from 'os';

/**
 * Aggregate Manager for Network Aggregation Operations
 * Handles aggregate creation, deletion, and link modification
 */

/**
 * Execute aggregate creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeCreateAggregateTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name, links, policy, lacp_mode, lacp_timer, unicast_address, temporary } = metadata;

    let command = `pfexec dladm create-aggr`;

    if (temporary) {
      command += ` -t`;
    }

    if (policy && policy !== 'L4') {
      command += ` -P ${policy}`;
    }

    if (lacp_mode && lacp_mode !== 'off') {
      command += ` -L ${lacp_mode}`;
    }
    if (lacp_timer && lacp_timer !== 'short') {
      command += ` -T ${lacp_timer}`;
    }

    if (unicast_address) {
      command += ` -u ${unicast_address}`;
    }

    for (const link of links) {
      command += ` -l ${link}`;
    }

    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Aggregate ${name} created successfully with links: ${links.join(', ')}`,
      };
    }
    return {
      success: false,
      error: `Failed to create aggregate ${name}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Aggregate creation task failed: ${error.message}` };
  }
};

/**
 * Execute aggregate deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDeleteAggregateTask = async metadataJson => {
  log.task.debug('Aggregate deletion task starting');

  try {
    const metadata = await parseAsync(metadataJson);
    const { aggregate, temporary } = metadata;

    log.task.debug('Aggregate deletion task parameters', {
      aggregate,
      temporary,
    });

    let command = `pfexec dladm delete-aggr`;
    if (temporary) {
      command += ` -t`;
    }
    command += ` ${aggregate}`;

    log.task.debug('Executing aggregate deletion command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.debug('Aggregate deleted from system, cleaning up database');

      const hostname = os.hostname();
      const cleanupResults = {
        network_interfaces: 0,
        network_usage: 0,
      };

      try {
        const interfacesDeleted = await NetworkInterfaces.destroy({
          where: {
            host: hostname,
            link: aggregate,
            class: 'aggr',
          },
        });
        cleanupResults.network_interfaces = interfacesDeleted;
        log.task.debug('Cleaned up network interface entries', {
          deleted_count: interfacesDeleted,
          aggregate,
        });

        const usageDeleted = await NetworkUsage.destroy({
          where: {
            host: hostname,
            link: aggregate,
          },
        });
        cleanupResults.network_usage = usageDeleted;
        log.task.debug('Cleaned up network usage entries', {
          deleted_count: usageDeleted,
          aggregate,
        });

        const totalCleaned = cleanupResults.network_interfaces + cleanupResults.network_usage;
        log.task.info('Database cleanup completed for aggregate', {
          total_cleaned: totalCleaned,
          aggregate,
        });

        return {
          success: true,
          message: `Aggregate ${aggregate} deleted successfully (system + ${totalCleaned} database entries cleaned)`,
          cleanup_summary: cleanupResults,
        };
      } catch (cleanupError) {
        log.task.warn('Aggregate deleted but database cleanup failed', {
          aggregate,
          error: cleanupError.message,
        });
        return {
          success: true,
          message: `Aggregate ${aggregate} deleted successfully (warning: database cleanup failed - ${cleanupError.message})`,
          cleanup_error: cleanupError.message,
        };
      }
    } else {
      log.task.error('Aggregate deletion command failed', {
        aggregate,
        error: result.error,
      });
      return {
        success: false,
        error: `Failed to delete aggregate ${aggregate}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('Aggregate deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Aggregate deletion task failed: ${error.message}` };
  }
};

/**
 * Execute aggregate links modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeModifyAggregateLinksTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { aggregate, operation, links, temporary } = metadata;

    let command = `pfexec dladm ${operation}-aggr`;
    if (temporary) {
      command += ` -t`;
    }

    for (const link of links) {
      command += ` -l ${link}`;
    }

    command += ` ${aggregate}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Successfully ${operation}ed links ${links.join(', ')} ${operation === 'add' ? 'to' : 'from'} aggregate ${aggregate}`,
      };
    }
    return {
      success: false,
      error: `Failed to ${operation} links on aggregate ${aggregate}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Aggregate links modification task failed: ${error.message}` };
  }
};
