/**
 * @fileoverview System Command Parsers for System Account Management
 * @description Utilities for parsing getent, user_attr, and RBAC system files
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { executeCommand } from '../../../lib/CommandManager.js';

/**
 * Parse passwd entry line into user object
 * @param {string} line - Single line from getent passwd output
 * @returns {Object|null} Parsed user object or null if invalid
 */
export const parsePasswdLine = line => {
  if (!line.trim()) {
    return null;
  }

  const fields = line.split(':');
  if (fields.length < 7) {
    return null;
  }

  return {
    username: fields[0],
    uid: parseInt(fields[2]),
    gid: parseInt(fields[3]),
    comment: fields[4] || '',
    home: fields[5] || '',
    shell: fields[6] || '',
  };
};

/**
 * Parse group entry line into group object
 * @param {string} line - Single line from getent group output
 * @returns {Object|null} Parsed group object or null if invalid
 */
export const parseGroupLine = line => {
  if (!line.trim()) {
    return null;
  }

  const fields = line.split(':');
  if (fields.length < 4) {
    return null;
  }

  return {
    groupname: fields[0],
    gid: parseInt(fields[2]),
    members: fields[3] ? fields[3].split(',').filter(m => m.trim()) : [],
  };
};

/**
 * Parse user_attr line for RBAC attributes
 * @param {string} line - Single line from user_attr file
 * @returns {Object|null} Parsed attributes object or null if invalid
 */
export const parseUserAttrLine = line => {
  if (!line.trim() || line.startsWith('#')) {
    return null;
  }

  const fields = line.split(':');
  if (fields.length < 5) {
    return null;
  }

  const [username, , , , attrString] = fields;

  const attributes = {
    username,
    type: 'normal',
    authorizations: [],
    profiles: [],
    roles: [],
    project: null,
  };

  if (attrString) {
    const attrPairs = attrString.split(';');
    for (const pair of attrPairs) {
      const [key, value] = pair.split('=');
      if (key && value) {
        const trimmedKey = key.trim();
        const trimmedValue = value.trim();

        switch (trimmedKey) {
          case 'type':
            attributes.type = trimmedValue;
            break;
          case 'auths':
            attributes.authorizations = trimmedValue.split(',').map(a => a.trim());
            break;
          case 'profiles':
            attributes.profiles = trimmedValue.split(',').map(p => p.trim());
            break;
          case 'roles':
            attributes.roles = trimmedValue.split(',').map(r => r.trim());
            break;
          case 'project':
            attributes.project = trimmedValue;
            break;
        }
      }
    }
  }

  return attributes;
};

/**
 * Parse auth_attr line for authorization details
 * @param {string} line - Single line from auth_attr file
 * @returns {Object|null} Parsed authorization object or null if invalid
 */
export const parseAuthAttrLine = line => {
  if (!line.trim() || line.startsWith('#')) {
    return null;
  }

  const fields = line.split(':');
  if (fields.length < 5) {
    return null;
  }

  const [authName, , , shortDesc, longDesc] = fields;

  // Skip heading entries (those ending with just a dot)
  if (authName.endsWith('.') && !authName.endsWith('..')) {
    return null;
  }

  return {
    name: authName,
    short_description: shortDesc || '',
    long_description: longDesc || '',
    is_grant: authName.endsWith('.grant'),
    prefix: authName.split('.').slice(0, -1).join('.'),
  };
};

/**
 * Parse prof_attr line for profile details
 * @param {string} line - Single line from prof_attr file
 * @returns {Object|null} Parsed profile object or null if invalid
 */
export const parseProfAttrLine = line => {
  if (!line.trim() || line.startsWith('#')) {
    return null;
  }

  const fields = line.split(':');
  if (fields.length < 5) {
    return null;
  }

  const [profileName, , , description, attrString] = fields;

  const attrs = {};
  if (attrString) {
    const attrPairs = attrString.split(';');
    for (const pair of attrPairs) {
      const [key, value] = pair.split('=');
      if (key && value) {
        attrs[key.trim()] = value.trim();
      }
    }
  }

  return {
    name: profileName,
    description,
    help: attrs.help || null,
    nested_profiles: attrs.profiles ? attrs.profiles.split(',') : [],
    authorizations: attrs.auths ? attrs.auths.split(',') : [],
    privileges: attrs.privs ? attrs.privs.split(',') : [],
  };
};

/**
 * Get system users with filtering and parsing
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Array of parsed user objects
 */
export const getSystemUsers = async (options = {}) => {
  const { include_system = true, limit = 50 } = options;

  const result = await executeCommand('getent passwd');
  if (!result.success) {
    throw new Error(`Failed to get passwd database: ${result.error}`);
  }

  const users = [];
  const lines = result.output.split('\n');

  for (const line of lines) {
    const user = parsePasswdLine(line);
    if (!user) {
      continue;
    }

    // Apply system user filtering
    if (!include_system && user.uid < 10) {
      continue;
    }

    users.push(user);

    if (users.length >= parseInt(limit)) {
      break;
    }
  }

  return users.sort((a, b) => a.username.localeCompare(b.username));
};

/**
 * Get system groups with filtering and parsing
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Array of parsed group objects
 */
export const getSystemGroups = async (options = {}) => {
  const { include_system = true, limit = 50 } = options;

  const result = await executeCommand('getent group');
  if (!result.success) {
    throw new Error(`Failed to get group database: ${result.error}`);
  }

  const groups = [];
  const lines = result.output.split('\n');

  for (const line of lines) {
    const group = parseGroupLine(line);
    if (!group) {
      continue;
    }

    // Apply system group filtering
    if (!include_system && group.gid < 10) {
      continue;
    }

    groups.push(group);

    if (groups.length >= parseInt(limit)) {
      break;
    }
  }

  return groups.sort((a, b) => a.groupname.localeCompare(b.groupname));
};
