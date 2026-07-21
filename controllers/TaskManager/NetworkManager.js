import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import { parseAsync } from '../../lib/AsyncJson.js';
import IPAddresses from '../../models/IPAddressModel.js';
import os from 'os';

/**
 * Network Manager for IP Address Operations
 * Handles IP address creation, deletion, enable/disable operations
 */

/**
 * Execute IP address creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeCreateIPAddressTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { type, addrobj, address, primary, wait, temporary, down } = metadata;

    let command = `pfexec ipadm create-addr`;

    // Add temporary flag
    if (temporary) {
      command += ` -t`;
    }

    // Build type-specific command
    switch (type) {
      case 'static':
        command += ` -T static`;
        if (down) {
          command += ` -d`;
        }
        command += ` -a ${address} ${addrobj}`;
        break;
      case 'dhcp':
        command += ` -T dhcp`;
        if (primary) {
          command += ` -1`;
        }
        if (wait) {
          command += ` -w ${wait}`;
        }
        command += ` ${addrobj}`;
        break;
      case 'addrconf':
        command += ` -T addrconf ${addrobj}`;
        break;
      default:
        return { success: false, error: `Unknown address type: ${type}` };
    }

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `IP address ${addrobj} created successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to create IP address ${addrobj}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `IP address creation task failed: ${error.message}` };
  }
};

/**
 * Execute IP address deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDeleteIPAddressTask = async metadataJson => {
  log.task.debug('IP address deletion task starting');

  try {
    const metadata = await parseAsync(metadataJson);
    const { addrobj, release } = metadata;

    log.task.debug('IP address deletion task parameters', {
      addrobj,
      release,
    });

    let command = `pfexec ipadm delete-addr`;
    if (release) {
      command += ` -r`;
    }
    command += ` ${addrobj}`;

    log.task.debug('Executing IP address deletion command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.debug('IP address deleted from system, cleaning up database');

      // Clean up all monitoring database entries for this IP address
      const hostname = os.hostname();
      const [interfaceName] = addrobj.split('/'); // Extract interface from addrobj (e.g., vnic0/v4static -> vnic0)

      const cleanupResults = {
        ip_addresses: 0,
        network_interfaces: 0,
        ip_interface_deleted: false,
      };

      // Check if there are any remaining IP addresses on this interface
      log.task.debug('Checking for remaining IP addresses', { interface: interfaceName });
      const remainingAddrsResult = await executeCommand(
        `pfexec ipadm show-addr -p -o addrobj,addr,type,state`
      );

      if (remainingAddrsResult.success && remainingAddrsResult.output.trim()) {
        // Parse all IP addresses and filter for our interface
        const allAddresses = remainingAddrsResult.output.trim().split('\n');
        const interfaceAddresses = allAddresses.filter(line =>
          line.startsWith(`${interfaceName}/`)
        );

        log.task.debug('IP address analysis', {
          interface: interfaceName,
          total_system_addresses: allAddresses.length,
          interface_addresses: interfaceAddresses.length,
          interface_address_list: interfaceAddresses,
        });

        if (interfaceAddresses.length === 0) {
          // No remaining IP addresses on this interface, safe to delete IP interface
          log.task.info('No remaining IP addresses found, deleting IP interface', {
            interface: interfaceName,
            deleted_addrobj: addrobj,
          });

          const deleteInterfaceResult = await executeCommand(
            `pfexec ipadm delete-if ${interfaceName}`
          );

          if (deleteInterfaceResult.success) {
            cleanupResults.ip_interface_deleted = true;
            log.task.info('IP interface deleted successfully', {
              interface: interfaceName,
              reason: 'no_remaining_addresses',
            });
          } else {
            log.task.warn('Failed to delete IP interface', {
              interface: interfaceName,
              error: deleteInterfaceResult.error,
            });
          }
        } else {
          // Other IP addresses still exist on this interface, keep interface
          log.task.info('Interface has remaining IP addresses, preserving interface', {
            interface: interfaceName,
            remaining_count: interfaceAddresses.length,
            remaining_addresses: interfaceAddresses,
            deleted_addrobj: addrobj,
          });
        }
      } else {
        // Command failed or no output - assume interface should be preserved for safety
        log.task.warn('Could not check remaining IP addresses, preserving interface for safety', {
          interface: interfaceName,
          error: remainingAddrsResult.error || 'no_output',
          deleted_addrobj: addrobj,
        });
      }

      try {
        // Clean up IPAddresses table (IP address monitoring data)
        const ipAddressesDeleted = await IPAddresses.destroy({
          where: {
            host: hostname,
            addrobj,
          },
        });
        cleanupResults.ip_addresses = ipAddressesDeleted;
        log.task.debug('Cleaned up IP address entries', {
          deleted_count: ipAddressesDeleted,
          addrobj,
        });

        // Note: NetworkInterfaces table tracks interfaces (like VNICs), not IP addresses
        // When deleting an IP address, we don't delete the interface entry itself
        // since the interface may still exist with other IP addresses
        cleanupResults.network_interfaces = 0;

        const totalCleaned = cleanupResults.ip_addresses;
        log.task.debug('Database cleanup completed', {
          total_cleaned: totalCleaned,
          addrobj,
        });

        return {
          success: true,
          message: `IP address ${addrobj} deleted successfully${cleanupResults.ip_interface_deleted ? ` (IP interface ${interfaceName} also deleted)` : ''} (system + ${totalCleaned} database entries cleaned)`,
          cleanup_summary: cleanupResults,
        };
      } catch (cleanupError) {
        log.task.warn('IP address deleted but database cleanup failed', {
          addrobj,
          error: cleanupError.message,
        });
        return {
          success: true,
          message: `IP address ${addrobj} deleted successfully${cleanupResults.ip_interface_deleted ? ` (IP interface ${interfaceName} also deleted)` : ''} (warning: database cleanup failed - ${cleanupError.message})`,
          cleanup_error: cleanupError.message,
        };
      }
    } else {
      log.task.error('IP address deletion command failed', {
        addrobj,
        error: result.error,
      });
      return {
        success: false,
        error: `Failed to delete IP address ${addrobj}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('IP address deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `IP address deletion task failed: ${error.message}` };
  }
};

/**
 * Execute IP address enable task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeEnableIPAddressTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { addrobj } = metadata;

    const result = await executeCommand(`pfexec ipadm enable-addr ${addrobj}`);

    if (result.success) {
      return {
        success: true,
        message: `IP address ${addrobj} enabled successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to enable IP address ${addrobj}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `IP address enable task failed: ${error.message}` };
  }
};

/**
 * Execute IP address disable task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDisableIPAddressTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { addrobj } = metadata;

    const result = await executeCommand(`pfexec ipadm disable-addr ${addrobj}`);

    if (result.success) {
      return {
        success: true,
        message: `IP address ${addrobj} disabled successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to disable IP address ${addrobj}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `IP address disable task failed: ${error.message}` };
  }
};
