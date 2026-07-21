import { parseAsync } from '../../lib/AsyncJson.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';

/**
 * Role Manager for Role Operations
 * Handles role creation, modification, and deletion
 */

/**
 * Helper function to build role command options
 * @param {Object} metadata - Role metadata
 * @returns {string} Command options string
 */
const buildRoleOptions = metadata => {
  const {
    uid,
    gid,
    comment,
    home_directory,
    shell,
    create_home,
    authorizations,
    profiles,
    project,
  } = metadata;

  let options = '';

  // Add UID
  if (uid) {
    options += ` -u ${uid}`;
  }

  // Add primary group
  if (gid) {
    options += ` -g ${gid}`;
  }

  // Add comment
  if (comment) {
    options += ` -c "${comment}"`;
  }

  // Add home directory
  if (home_directory) {
    options += ` -d "${home_directory}"`;
  }

  // Add shell (defaults to /bin/pfsh for roles)
  if (shell && shell !== '/bin/pfsh') {
    options += ` -s "${shell}"`;
  }

  // Add home directory creation
  if (create_home) {
    options += ` -m`;
  }

  // Add project
  if (project) {
    options += ` -p "${project}"`;
  }

  // Add RBAC authorizations
  if (authorizations && authorizations.length > 0) {
    options += ` -A "${authorizations.join(',')}"`;
  }

  // Add RBAC profiles
  if (profiles && profiles.length > 0) {
    options += ` -P "${profiles.join(',')}"`;
  }

  return options;
};

/**
 * Execute role creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRoleCreateTask = async metadataJson => {
  log.task.debug('Role creation task starting');

  try {
    const metadata = await parseAsync(metadataJson);

    const {
      rolename,
      uid,
      gid,
      create_home = false,
      authorizations = [],
      profiles = [],
    } = metadata;

    log.task.debug('Role creation task parameters', {
      rolename,
      uid,
      gid,
      create_home,
      has_rbac: authorizations.length > 0 || profiles.length > 0,
    });

    // Build roleadd command using helper function
    const command = `pfexec roleadd${buildRoleOptions(metadata)} ${rolename}`;

    log.task.debug('Executing role creation command', { command });

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
        warnings.push(`Role name '${rolename}' is longer than traditional 8-character limit`);
      }

      log.task.info('Role created successfully', {
        rolename,
        uid: uid || 'auto-assigned',
        warnings: warnings.length,
      });

      return {
        success: true,
        message: `Role ${rolename} created successfully${warnings.length > 0 ? ' (with warnings)' : ''}`,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }
    log.task.error('Role creation command failed', {
      rolename,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to create role ${rolename}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('Role creation task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Role creation task failed: ${error.message}` };
  }
};

/**
 * Execute role modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRoleModifyTask = async metadataJson => {
  log.task.debug('Role modification task starting');

  try {
    const metadata = await parseAsync(metadataJson);

    const {
      rolename,
      new_rolename,
      new_uid,
      new_gid,
      new_comment,
      new_authorizations = [],
      new_profiles = [],
    } = metadata;

    log.task.debug('Role modification task parameters', {
      rolename,
      new_rolename,
      new_uid,
      has_rbac: new_authorizations.length > 0 || new_profiles.length > 0,
    });

    // Build rolemod command
    let command = `pfexec rolemod`;

    // Add new UID
    if (new_uid) {
      command += ` -u ${new_uid}`;
    }

    // Add new primary group
    if (new_gid) {
      command += ` -g ${new_gid}`;
    }

    // Add new comment
    if (new_comment !== undefined) {
      command += ` -c "${new_comment}"`;
    }

    // Add new RBAC authorizations
    if (new_authorizations && new_authorizations.length > 0) {
      command += ` -A "${new_authorizations.join(',')}"`;
    }

    // Add new RBAC profiles
    if (new_profiles && new_profiles.length > 0) {
      command += ` -P "${new_profiles.join(',')}"`;
    }

    // Add new role name (must be last for rolemod -l)
    if (new_rolename) {
      command += ` -l ${new_rolename}`;
    }

    // Add current role name
    command += ` ${rolename}`;

    log.task.debug('Executing role modification command', { command });

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
          `Role name '${new_rolename || rolename}' is longer than traditional 8-character limit`
        );
      }

      log.task.info('Role modified successfully', {
        rolename,
        new_rolename: new_rolename || rolename,
        warnings: warnings.length,
      });

      return {
        success: true,
        message: `Role ${rolename}${new_rolename ? ` renamed to ${new_rolename}` : ''} modified successfully${warnings.length > 0 ? ' (with warnings)' : ''}`,
        warnings: warnings.length > 0 ? warnings : undefined,
        final_rolename: new_rolename || rolename,
      };
    }
    log.task.error('Role modification command failed', {
      rolename,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to modify role ${rolename}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('Role modification task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Role modification task failed: ${error.message}` };
  }
};

/**
 * Execute role deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRoleDeleteTask = async metadataJson => {
  log.task.debug('Role deletion task starting');

  try {
    const metadata = await parseAsync(metadataJson);

    const { rolename, remove_home = false } = metadata;

    log.task.debug('Role deletion task parameters', {
      rolename,
      remove_home,
    });

    let actuallyRemoveHome = false;

    // Check if role has a home directory before attempting to remove it
    if (remove_home) {
      log.task.debug('Checking if role has home directory', { rolename });

      const checkHomeResult = await executeCommand(`pfexec getent passwd ${rolename}`);

      if (checkHomeResult.success && checkHomeResult.output && checkHomeResult.output.trim()) {
        // Parse the getent passwd output: username:x:uid:gid:comment:home_dir:shell
        const fields = checkHomeResult.output.trim().split(':');
        if (fields.length >= 6 && fields[5] && fields[5].trim() !== '' && fields[5] !== '/') {
          actuallyRemoveHome = true;
          log.task.debug('Role has home directory, will remove it', {
            rolename,
            home_dir: fields[5],
          });
        } else {
          log.task.debug('Role has no home directory or uses root home, skipping -r flag', {
            rolename,
            home_dir: fields[5] || 'none',
          });
        }
      } else {
        log.task.debug('Role not found in passwd database, skipping -r flag', { rolename });
      }
    }

    // Build roledel command
    let command = `pfexec roledel`;

    if (actuallyRemoveHome) {
      command += ` -r`;
    }

    command += ` ${rolename}`;

    log.task.debug('Executing role deletion command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.info('Role deleted successfully', {
        rolename,
        home_removed: actuallyRemoveHome,
        home_removal_requested: remove_home,
      });

      let message = `Role ${rolename} deleted successfully`;
      if (remove_home) {
        message += actuallyRemoveHome
          ? ' (home directory removed)'
          : ' (no home directory to remove)';
      }

      return {
        success: true,
        message,
        home_removed: actuallyRemoveHome,
        home_removal_requested: remove_home,
      };
    }
    log.task.error('Role deletion command failed', {
      rolename,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to delete role ${rolename}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('Role deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Role deletion task failed: ${error.message}` };
  }
};
