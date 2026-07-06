/**
 * @fileoverview User Account State Manager for User Account Operations
 * @description Handles user deletion, password setting, locking, and unlocking task executors
 */

import yj from 'yieldable-json';
import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';

/**
 * Execute user deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeUserDeleteTask = async metadataJson => {
  log.task.debug('User deletion task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { username, remove_home = false, delete_personal_group = false } = metadata;

    log.task.debug('User deletion task parameters', {
      username,
      remove_home,
      delete_personal_group,
    });

    // Build userdel command
    let command = `pfexec userdel`;

    if (remove_home) {
      command += ` -r`;
    }

    command += ` ${username}`;

    log.task.debug('Executing user deletion command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      let groupDeleted = false;

      // Step 2: Delete personal group if requested and it exists
      if (delete_personal_group) {
        log.task.debug('Attempting to delete personal group', { groupname: username });

        const groupDelResult = await executeCommand(`pfexec groupdel ${username}`);

        if (groupDelResult.success) {
          groupDeleted = true;
          log.task.info('Personal group deleted', { groupname: username });
        } else {
          log.task.debug('Personal group deletion failed (may not exist)', {
            groupname: username,
            error: groupDelResult.error,
          });
        }
      }

      log.task.info('User deleted successfully', {
        username,
        home_removed: remove_home,
        group_deleted: groupDeleted,
      });

      return {
        success: true,
        message: `User ${username} deleted successfully${remove_home ? ' (home directory removed)' : ''}${groupDeleted ? ` (personal group '${username}' also deleted)` : ''}`,
        home_removed: remove_home,
        group_deleted: groupDeleted,
      };
    }
    log.task.error('User deletion command failed', {
      username,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to delete user ${username}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('User deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User deletion task failed: ${error.message}` };
  }
};

/**
 * Execute user password setting task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeUserSetPasswordTask = async metadataJson => {
  log.task.debug('User password setting task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { username, password, force_change = false, unlock_account = true } = metadata;

    log.task.debug('User password setting task parameters', {
      username,
      force_change,
      unlock_account,
      password_length: password ? password.length : 0,
    });

    // Set password using passwd command with echo
    const command = `echo "${password}" | pfexec passwd --stdin ${username}`;
    log.task.debug('Executing password setting command', {
      command: command.replace(password, '[REDACTED]'),
    });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.info('Password set successfully', {
        username,
        force_change,
        unlock_account,
      });

      // Force password change on next login if requested
      if (force_change) {
        const expireResult = await executeCommand(`pfexec passwd -f ${username}`);
        if (!expireResult.success) {
          log.task.warn('Password set but failed to force change on next login', {
            username,
            error: expireResult.error,
          });
        }
      }

      // Unlock account if requested (passwords are typically set for locked accounts)
      if (unlock_account) {
        const unlockResult = await executeCommand(`pfexec passwd -u ${username}`);
        if (!unlockResult.success) {
          log.task.warn('Password set but failed to unlock account', {
            username,
            error: unlockResult.error,
          });
        }
      }

      return {
        success: true,
        message: `Password set successfully for user ${username}${force_change ? ' (must change on next login)' : ''}${unlock_account ? ' (account unlocked)' : ''}`,
        force_change,
        unlock_account,
      };
    }
    log.task.error('Password setting command failed', {
      username,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to set password for user ${username}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('User password setting task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User password setting task failed: ${error.message}` };
  }
};

/**
 * Execute user account lock task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeUserLockTask = async metadataJson => {
  log.task.debug('User account lock task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { username } = metadata;

    log.task.debug('User account lock task parameters', {
      username,
    });

    const command = `pfexec passwd -l ${username}`;

    log.task.debug('Executing user account lock command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.info('User account locked successfully', {
        username,
      });

      return {
        success: true,
        message: `User account ${username} locked successfully`,
      };
    }
    log.task.error('User account lock command failed', {
      username,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to lock user account ${username}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('User account lock task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User account lock task failed: ${error.message}` };
  }
};

/**
 * Execute user account unlock task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeUserUnlockTask = async metadataJson => {
  log.task.debug('User account unlock task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { username } = metadata;

    log.task.debug('User account unlock task parameters', {
      username,
    });

    const command = `pfexec passwd -u ${username}`;

    log.task.debug('Executing user account unlock command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.info('User account unlocked successfully', {
        username,
      });

      return {
        success: true,
        message: `User account ${username} unlocked successfully`,
      };
    }
    log.task.error('User account unlock command failed', {
      username,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to unlock user account ${username}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('User account unlock task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User account unlock task failed: ${error.message}` };
  }
};
