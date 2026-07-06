/**
 * @fileoverview User Provisioning Manager for User Account Operations
 * @description Handles user creation and modification task executors
 */

import yj from 'yieldable-json';
import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';

/**
 * Helper function to create personal group for user
 * @param {string} username - Username for group
 * @param {number} uid - UID for group
 * @param {Array} warnings - Warnings array to update
 * @returns {Promise<{createdGroup: string|null, warnings: Array}>}
 */
const createPersonalGroup = async (username, uid, warnings) => {
  log.task.debug('Creating personal group', { groupname: username });

  let groupCommand = `pfexec groupadd`;
  if (uid) {
    groupCommand += ` -g ${uid}`;
  }
  groupCommand += ` ${username}`;

  const groupResult = await executeCommand(groupCommand);

  if (groupResult.success) {
    log.task.info('Personal group created', { groupname: username, gid: uid });
    return { createdGroup: username, warnings };
  } else if (groupResult.error && groupResult.error.includes('name too long')) {
    warnings.push(`Group name '${username}' is longer than recommended but was created`);
    return { createdGroup: username, warnings };
  }
  log.task.warn('Failed to create personal group, continuing without it', {
    groupname: username,
    error: groupResult.error,
  });
  warnings.push(`Failed to create personal group '${username}': ${groupResult.error}`);
  return { createdGroup: null, warnings };
};

/**
 * Helper function to build user creation command
 * @param {Object} params - User parameters
 * @param {string} createdGroup - Created group name
 * @returns {string} Complete useradd command
 */
const buildUserCreateCommand = (params, createdGroup) => {
  const {
    username,
    uid,
    gid,
    groups,
    comment,
    home_directory,
    shell,
    create_home,
    skeleton_dir,
    expire_date,
    inactive_days,
    project,
    authorizations,
    profiles,
    roles,
    force_zfs,
    prevent_zfs,
  } = params;

  let command = `pfexec useradd`;

  // Add UID
  if (uid) {
    command += ` -u ${uid}`;
  }

  // Add primary group (personal group if created, or specified gid)
  if (createdGroup) {
    command += ` -g ${createdGroup}`;
  } else if (gid) {
    command += ` -g ${gid}`;
  }

  // Add supplementary groups
  if (groups && groups.length > 0) {
    command += ` -G ${groups.join(',')}`;
  }

  // Add comment
  if (comment) {
    command += ` -c "${comment}"`;
  }

  // Add home directory
  if (home_directory) {
    command += ` -d "${home_directory}"`;
  }

  // Add shell
  if (shell && shell !== '/bin/sh') {
    command += ` -s "${shell}"`;
  }

  // Add home directory creation with ZFS options
  if (create_home) {
    if (force_zfs) {
      command += ` -m -z`;
    } else if (prevent_zfs) {
      command += ` -m -Z`;
    } else {
      command += ` -m`;
    }

    // Add skeleton directory
    if (skeleton_dir) {
      command += ` -k "${skeleton_dir}"`;
    }
  }

  // Add expiration date
  if (expire_date) {
    command += ` -e "${expire_date}"`;
  }

  // Add inactive days
  if (inactive_days) {
    command += ` -f ${inactive_days}`;
  }

  // Add project
  if (project) {
    command += ` -p "${project}"`;
  }

  // Add RBAC authorizations
  if (authorizations && authorizations.length > 0) {
    command += ` -A "${authorizations.join(',')}"`;
  }

  // Add RBAC profiles
  if (profiles && profiles.length > 0) {
    command += ` -P "${profiles.join(',')}"`;
  }

  // Add RBAC roles
  if (roles && roles.length > 0) {
    command += ` -R "${roles.join(',')}"`;
  }

  // Add username
  command += ` ${username}`;

  return command;
};

/**
 * Execute user creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeUserCreateTask = async metadataJson => {
  log.task.debug('User creation task starting');

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

    const {
      username,
      uid,
      gid,
      authorizations = [],
      profiles = [],
      roles = [],
      create_personal_group = true,
    } = metadata;

    log.task.debug('User creation task parameters', {
      username,
      uid,
      gid,
      create_personal_group,
      has_rbac: authorizations.length > 0 || profiles.length > 0 || roles.length > 0,
    });

    let warnings = [];
    let createdGroup = null;

    // Step 1: Create personal group if requested and no gid specified
    if (create_personal_group && !gid) {
      const { createdGroup: newGroup, warnings: newWarnings } = await createPersonalGroup(
        username,
        uid,
        warnings
      );
      createdGroup = newGroup;
      warnings = newWarnings;
    }

    // Step 2: Build useradd command using helper function
    const command = buildUserCreateCommand(metadata, createdGroup);
    log.task.debug('Executing user creation command', { command });

    // Execute user creation
    const result = await executeCommand(command);

    if (
      result.success ||
      (result.stderr &&
        result.stderr.includes('name too long') &&
        !result.stderr.includes('ERROR:'))
    ) {
      // Handle success or success with warnings
      if (result.stderr && result.stderr.includes('name too long')) {
        warnings.push(`Username '${username}' is longer than traditional 8-character limit`);
      }

      log.task.info('User created successfully', {
        username,
        uid: uid || 'auto-assigned',
        personal_group_created: !!createdGroup,
        warnings: warnings.length,
      });

      const message = `User ${username} created successfully${createdGroup ? ` with personal group '${createdGroup}'` : ''}${warnings.length > 0 ? ' (with warnings)' : ''}`;

      return {
        success: true,
        message,
        warnings: warnings.length > 0 ? warnings : undefined,
        created_group: createdGroup,
        system_output: result.output,
      };
    }
    log.task.error('User creation command failed', {
      username,
      error: result.error,
      created_group: createdGroup,
    });

    // If we created a group but user creation failed, clean up the group
    if (createdGroup) {
      log.task.debug('Cleaning up created group due to user creation failure');
      await executeCommand(`pfexec groupdel ${createdGroup}`);
    }

    return {
      success: false,
      error: `Failed to create user ${username}: ${result.error}`,
      group_cleanup_performed: !!createdGroup,
    };
  } catch (error) {
    log.task.error('User creation task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User creation task failed: ${error.message}` };
  }
};

/**
 * Helper function to build user modification command
 * @param {Object} params - User modification parameters
 * @returns {string} Complete usermod command
 */
const buildUserModifyCommand = params => {
  const {
    username,
    new_username,
    new_uid,
    new_gid,
    new_groups,
    new_comment,
    new_home_directory,
    move_home,
    new_shell,
    new_expire_date,
    new_inactive_days,
    new_project,
    new_authorizations,
    new_profiles,
    new_roles,
    force_zfs,
    prevent_zfs,
  } = params;

  let command = `pfexec usermod`;

  // Add new UID
  if (new_uid) {
    command += ` -u ${new_uid}`;
  }

  // Add new primary group
  if (new_gid) {
    command += ` -g ${new_gid}`;
  }

  // Add new supplementary groups
  if (new_groups && new_groups.length > 0) {
    command += ` -G ${new_groups.join(',')}`;
  }

  // Add new comment
  if (new_comment !== undefined) {
    command += ` -c "${new_comment}"`;
  }

  // Add new home directory with move option
  if (new_home_directory) {
    command += ` -d "${new_home_directory}"`;

    if (move_home) {
      if (force_zfs) {
        command += ` -m -z`;
      } else if (prevent_zfs) {
        command += ` -m -Z`;
      } else {
        command += ` -m`;
      }
    }
  }

  // Add new shell
  if (new_shell) {
    command += ` -s "${new_shell}"`;
  }

  // Add new expiration date
  if (new_expire_date !== undefined) {
    command += ` -e "${new_expire_date}"`;
  }

  // Add new inactive days
  if (new_inactive_days !== undefined) {
    command += ` -f ${new_inactive_days}`;
  }

  // Add new project
  if (new_project) {
    command += ` -p "${new_project}"`;
  }

  // Add new RBAC authorizations
  if (new_authorizations && new_authorizations.length > 0) {
    command += ` -A "${new_authorizations.join(',')}"`;
  }

  // Add new RBAC profiles
  if (new_profiles && new_profiles.length > 0) {
    command += ` -P "${new_profiles.join(',')}"`;
  }

  // Add new RBAC roles
  if (new_roles && new_roles.length > 0) {
    command += ` -R "${new_roles.join(',')}"`;
  }

  // Add new username (must be last for usermod -l)
  if (new_username) {
    command += ` -l ${new_username}`;
  }

  // Add current username
  command += ` ${username}`;

  return command;
};

/**
 * Execute user modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeUserModifyTask = async metadataJson => {
  log.task.debug('User modification task starting');

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

    const {
      username,
      new_username,
      new_uid,
      move_home = false,
      new_authorizations = [],
      new_profiles = [],
      new_roles = [],
    } = metadata;

    log.task.debug('User modification task parameters', {
      username,
      new_username,
      new_uid,
      move_home,
      has_rbac: new_authorizations.length > 0 || new_profiles.length > 0 || new_roles.length > 0,
    });

    // Build usermod command using helper function
    const command = buildUserModifyCommand(metadata);
    log.task.debug('Executing user modification command', { command });

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
          `Username '${new_username || username}' is longer than traditional 8-character limit`
        );
      }

      log.task.info('User modified successfully', {
        username,
        new_username: new_username || username,
        move_home,
        warnings: warnings.length,
      });

      return {
        success: true,
        message: `User ${username}${new_username ? ` renamed to ${new_username}` : ''} modified successfully${warnings.length > 0 ? ' (with warnings)' : ''}`,
        warnings: warnings.length > 0 ? warnings : undefined,
        final_username: new_username || username,
      };
    }
    log.task.error('User modification command failed', {
      username,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to modify user ${username}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('User modification task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User modification task failed: ${error.message}` };
  }
};
