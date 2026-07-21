import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import { parseAsync } from '../../lib/AsyncJson.js';
import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import NetworkUsage from '../../models/NetworkUsageModel.js';
import os from 'os';

/**
 * VNIC Manager for Virtual Network Interface Operations
 * Handles VNIC creation, deletion, and property modification
 */

/**
 * Build MAC address configuration for VNIC command
 * @param {string} mac_address - MAC address type or value
 * @param {string} mac_prefix - MAC prefix for random generation
 * @param {number} slot - Slot number for factory MAC
 * @returns {string} MAC configuration string
 */
const buildMacConfiguration = (mac_address, mac_prefix, slot) => {
  let macConfig = '';

  if (mac_address === 'factory') {
    macConfig = ` -m factory -n ${slot}`;
    log.task.debug('Added factory MAC to command', { slot });
  } else if (mac_address === 'random') {
    macConfig = ` -m random`;
    log.task.debug('Added random MAC to command');
    if (mac_prefix) {
      macConfig += ` -r ${mac_prefix}`;
      log.task.debug('Added MAC prefix to command', { mac_prefix });
    }
  } else if (mac_address === 'auto') {
    macConfig = ` -m auto`;
    log.task.debug('Added auto MAC to command');
  } else if (mac_address && mac_address !== 'auto') {
    macConfig = ` -m ${mac_address}`;
    log.task.debug('Added specific MAC to command', { mac_address });
  } else {
    log.task.debug('Using default MAC assignment');
  }

  return macConfig;
};

/**
 * Build VNIC creation command
 * @param {Object} params - VNIC parameters
 * @returns {string} Complete dladm command
 */
const buildVNICCommand = params => {
  const { name, link, mac_address, mac_prefix, slot, vlan_id, temporary, properties } = params;

  let command = `pfexec dladm create-vnic`;

  if (temporary) {
    command += ` -t`;
    log.task.debug('Added temporary flag to command');
  }

  if (link) {
    command += ` -l ${link}`;
    log.task.debug('Added link to command', { link });
  }

  // Add MAC address configuration
  command += buildMacConfiguration(mac_address, mac_prefix, slot);

  if (vlan_id) {
    command += ` -v ${vlan_id}`;
    log.task.debug('Added VLAN ID to command', { vlan_id });
  }

  if (properties && Object.keys(properties).length > 0) {
    const propList = Object.entries(properties)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    command += ` -p ${propList}`;
    log.task.debug('Added properties to command', { properties: propList });
  }

  if (name) {
    command += ` ${name}`;
    log.task.debug('Added VNIC name to command', { name });
  }

  return command;
};

/**
 * Execute VNIC creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeCreateVNICTask = async metadataJson => {
  log.task.debug('VNIC creation task starting', {
    metadata_type: typeof metadataJson,
    metadata_length: metadataJson ? metadataJson.length : 0,
  });

  try {
    if (!metadataJson) {
      log.task.error('VNIC creation task metadata is undefined or null');
      return { success: false, error: 'Task metadata is missing - cannot build dladm command' };
    }

    let metadata;
    try {
      metadata = await parseAsync(metadataJson);
      log.task.debug('Successfully parsed metadata', { metadata });
    } catch (parseError) {
      log.task.error('Failed to parse metadata JSON', {
        error: parseError.message,
      });
      return { success: false, error: `Invalid JSON metadata: ${parseError.message}` };
    }

    const { name, link } = metadata;

    // Validate required parameters
    if (!name || !link) {
      log.task.error('Missing required parameters - cannot execute command', {
        name_missing: !name,
        link_missing: !link,
      });
      return {
        success: false,
        error: `Missing required parameters: ${!name ? 'name ' : ''}${!link ? 'link' : ''}`,
      };
    }

    log.task.debug('Building dladm create-vnic command', { metadata });
    const command = buildVNICCommand(metadata);
    log.task.debug('Final VNIC creation command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.info('VNIC creation completed', { name, link });
      return {
        success: true,
        message: `VNIC ${name} created successfully over ${link}`,
      };
    }
    log.task.error('VNIC creation failed', {
      name,
      error: result.error,
    });
    return {
      success: false,
      error: `Failed to create VNIC ${name}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('VNIC creation task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `VNIC creation task failed: ${error.message}` };
  }
};

/**
 * Execute VNIC deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDeleteVNICTask = async metadataJson => {
  log.task.debug('VNIC deletion task starting');

  try {
    const metadata = await parseAsync(metadataJson);
    const { vnic, temporary } = metadata;

    log.task.debug('VNIC deletion task parameters', {
      vnic,
      temporary,
    });

    let command = `pfexec dladm delete-vnic`;
    if (temporary) {
      command += ` -t`;
    }
    command += ` ${vnic}`;

    log.task.debug('Executing VNIC deletion command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.debug('VNIC deleted from system, cleaning up database');

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
            link: vnic,
            class: 'vnic',
          },
        });
        cleanupResults.network_interfaces = interfacesDeleted;
        log.task.debug('Cleaned up network interface entries', {
          deleted_count: interfacesDeleted,
          vnic,
        });

        const usageDeleted = await NetworkUsage.destroy({
          where: {
            host: hostname,
            link: vnic,
          },
        });
        cleanupResults.network_usage = usageDeleted;
        log.task.debug('Cleaned up network usage entries', {
          deleted_count: usageDeleted,
          vnic,
        });

        const totalCleaned = cleanupResults.network_interfaces + cleanupResults.network_usage;
        log.task.info('Database cleanup completed for VNIC', {
          total_cleaned: totalCleaned,
          vnic,
        });

        return {
          success: true,
          message: `VNIC ${vnic} deleted successfully (system + ${totalCleaned} database entries cleaned)`,
          cleanup_summary: cleanupResults,
        };
      } catch (cleanupError) {
        log.task.warn('VNIC deleted but database cleanup failed', {
          vnic,
          error: cleanupError.message,
        });
        return {
          success: true,
          message: `VNIC ${vnic} deleted successfully (warning: database cleanup failed - ${cleanupError.message})`,
          cleanup_error: cleanupError.message,
        };
      }
    } else {
      log.task.error('VNIC deletion command failed', {
        vnic,
        error: result.error,
      });
      return {
        success: false,
        error: `Failed to delete VNIC ${vnic}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('VNIC deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `VNIC deletion task failed: ${error.message}` };
  }
};

/**
 * Execute VNIC properties setting task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeSetVNICPropertiesTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { vnic, properties, temporary } = metadata;

    let command = `pfexec dladm set-linkprop`;
    if (temporary) {
      command += ` -t`;
    }

    const propList = Object.entries(properties)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');

    command += ` -p ${propList} ${vnic}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `VNIC ${vnic} properties set successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to set VNIC ${vnic} properties: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `VNIC properties task failed: ${error.message}` };
  }
};
