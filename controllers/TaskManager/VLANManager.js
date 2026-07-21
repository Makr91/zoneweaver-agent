import { executeCommand } from '../../lib/CommandManager.js';
import { parseAsync } from '../../lib/AsyncJson.js';
import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import NetworkUsage from '../../models/NetworkUsageModel.js';

/**
 * VLAN Manager for Virtual LAN Operations
 * Handles VLAN creation and deletion
 */

/**
 * Execute VLAN creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeCreateVlanTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { vid, link, name, force, temporary } = metadata;

    let command = `pfexec dladm create-vlan`;
    if (force) {
      command += ` -f`;
    }
    if (temporary) {
      command += ` -t`;
    }
    command += ` -l ${link} -v ${vid}`;
    if (name) {
      command += ` ${name}`;
    }

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `VLAN ${name || `${link}_${vid}`} created successfully (VID ${vid}) over ${link}`,
      };
    }
    return {
      success: false,
      error: `Failed to create VLAN ${name || `${link}_${vid}`}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `VLAN creation task failed: ${error.message}` };
  }
};

/**
 * Execute VLAN deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDeleteVlanTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { vlan, temporary } = metadata;

    let command = `pfexec dladm delete-vlan`;
    if (temporary) {
      command += ` -t`;
    }
    command += ` ${vlan}`;

    const result = await executeCommand(command);

    if (result.success) {
      // Clean up associated data
      await NetworkInterfaces.destroy({ where: { link: vlan } });
      await NetworkUsage.destroy({ where: { link: vlan } });

      return {
        success: true,
        message: `VLAN ${vlan} deleted successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to delete VLAN ${vlan}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `VLAN deletion task failed: ${error.message}` };
  }
};
