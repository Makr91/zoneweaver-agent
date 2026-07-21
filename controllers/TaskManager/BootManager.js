import { parseAsync } from '../../lib/AsyncJson.js';
import { executeCommand } from '../../lib/CommandManager.js';

/**
 * Boot Manager for Boot Environment Operations
 * Handles boot environment creation, deletion, activation, mounting, and unmounting
 */

/**
 * Execute boot environment creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeBeadmCreateTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name, description, source_be, snapshot, activate, zpool, properties } = metadata;

    let command = `pfexec beadm create`;

    if (activate) {
      command += ` -a`;
    }

    if (description) {
      command += ` -d "${description}"`;
    }

    if (source_be) {
      command += ` -e ${source_be}`;
    } else if (snapshot) {
      command += ` -e ${snapshot}`;
    }

    if (zpool) {
      command += ` -p ${zpool}`;
    }

    // Add properties if specified
    if (properties && Object.keys(properties).length > 0) {
      for (const [key, value] of Object.entries(properties)) {
        command += ` -o ${key}=${value}`;
      }
    }

    // Add BE name
    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Boot environment '${name}' created successfully${activate ? ' and activated' : ''}`,
      };
    }
    return {
      success: false,
      error: `Failed to create boot environment '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Boot environment creation task failed: ${error.message}` };
  }
};

/**
 * Execute boot environment deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeBeadmDeleteTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name, force, snapshots } = metadata;

    let command = `pfexec beadm destroy`;

    if (force) {
      command += ` -F`;
    }

    if (snapshots) {
      command += ` -s`;
    }

    // Add BE name
    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Boot environment '${name}' deleted successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to delete boot environment '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Boot environment deletion task failed: ${error.message}` };
  }
};

/**
 * Execute boot environment activation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeBeadmActivateTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name, temporary } = metadata;

    let command = `pfexec beadm activate`;

    if (temporary) {
      command += ` -t`;
    }

    // Add BE name
    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Boot environment '${name}' activated successfully${temporary ? ' (temporary)' : ''}`,
      };
    }
    return {
      success: false,
      error: `Failed to activate boot environment '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Boot environment activation task failed: ${error.message}` };
  }
};

/**
 * Execute boot environment mount task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeBeadmMountTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name, mountpoint, shared_mode } = metadata;

    let command = `pfexec beadm mount`;

    if (shared_mode) {
      command += ` -s ${shared_mode}`;
    }

    // Add BE name and mountpoint
    command += ` ${name} ${mountpoint}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Boot environment '${name}' mounted successfully at '${mountpoint}'`,
      };
    }
    return {
      success: false,
      error: `Failed to mount boot environment '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Boot environment mount task failed: ${error.message}` };
  }
};

/**
 * Execute boot environment unmount task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeBeadmUnmountTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name, force } = metadata;

    let command = `pfexec beadm unmount`;

    if (force) {
      command += ` -f`;
    }

    // Add BE name
    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Boot environment '${name}' unmounted successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to unmount boot environment '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Boot environment unmount task failed: ${error.message}` };
  }
};
