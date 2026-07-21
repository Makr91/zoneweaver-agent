import { parseAsync } from '../../lib/AsyncJson.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';

/**
 * Group Manager for Group Operations
 * Handles group creation, modification, and deletion
 */

/**
 * Execute group creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeGroupCreateTask = async metadataJson => {
  log.task.debug('Group creation task starting');

  try {
    const metadata = await parseAsync(metadataJson);

    const { groupname, gid } = metadata;

    log.task.debug('Group creation task parameters', {
      groupname,
      gid,
    });

    // Build groupadd command
    let command = `pfexec groupadd`;

    if (gid) {
      command += ` -g ${gid}`;
    }

    command += ` ${groupname}`;

    log.task.debug('Executing group creation command', { command });

    const result = await executeCommand(command);

    const warnings = [];
    if (
      result.success ||
      (result.stderr &&
        result.stderr.includes('name too long') &&
        !result.stderr.includes('ERROR:'))
    ) {
      // Handle success or success with warnings
      if (result.stderr && result.stderr.includes('name too long')) {
        warnings.push(`Group name '${groupname}' is longer than traditional limit`);
      }

      log.task.info('Group created successfully', {
        groupname,
        gid: gid || 'auto-assigned',
        warnings: warnings.length,
      });

      return {
        success: true,
        message: `Group ${groupname} created successfully${warnings.length > 0 ? ' (with warnings)' : ''}`,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }
    log.task.error('Group creation command failed', {
      groupname,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to create group ${groupname}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('Group creation task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Group creation task failed: ${error.message}` };
  }
};

/**
 * Execute group modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeGroupModifyTask = async metadataJson => {
  log.task.debug('Group modification task starting');

  try {
    const metadata = await parseAsync(metadataJson);

    const { groupname, new_groupname, new_gid } = metadata;

    log.task.debug('Group modification task parameters', {
      groupname,
      new_groupname,
      new_gid,
    });

    // Build groupmod command
    let command = `pfexec groupmod`;

    if (new_gid) {
      command += ` -g ${new_gid}`;
    }

    if (new_groupname) {
      command += ` -n ${new_groupname}`;
    }

    command += ` ${groupname}`;

    log.task.debug('Executing group modification command', { command });

    const result = await executeCommand(command);

    const warnings = [];
    if (
      result.success ||
      (result.stderr &&
        result.stderr.includes('name too long') &&
        !result.stderr.includes('ERROR:'))
    ) {
      // Handle success or success with warnings
      if (result.stderr && result.stderr.includes('name too long')) {
        warnings.push(
          `Group name '${new_groupname || groupname}' is longer than traditional limit`
        );
      }

      log.task.info('Group modified successfully', {
        groupname,
        new_groupname: new_groupname || groupname,
        new_gid,
        warnings: warnings.length,
      });

      return {
        success: true,
        message: `Group ${groupname}${new_groupname ? ` renamed to ${new_groupname}` : ''} modified successfully${warnings.length > 0 ? ' (with warnings)' : ''}`,
        warnings: warnings.length > 0 ? warnings : undefined,
        final_groupname: new_groupname || groupname,
      };
    }
    log.task.error('Group modification command failed', {
      groupname,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to modify group ${groupname}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('Group modification task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Group modification task failed: ${error.message}` };
  }
};

/**
 * Execute group deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeGroupDeleteTask = async metadataJson => {
  log.task.debug('Group deletion task starting');

  try {
    const metadata = await parseAsync(metadataJson);

    const { groupname } = metadata;

    log.task.debug('Group deletion task parameters', {
      groupname,
    });

    const command = `pfexec groupdel ${groupname}`;

    log.task.debug('Executing group deletion command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.info('Group deleted successfully', {
        groupname,
      });

      return {
        success: true,
        message: `Group ${groupname} deleted successfully`,
      };
    }
    log.task.error('Group deletion command failed', {
      groupname,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to delete group ${groupname}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('Group deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Group deletion task failed: ${error.message}` };
  }
};
