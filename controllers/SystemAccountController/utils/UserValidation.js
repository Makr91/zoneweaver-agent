/**
 * @fileoverview User Validation Utilities for System Account Management
 * @description Validation functions for usernames, UIDs, group names, and system account parameters
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

/**
 * Validate username format according to OmniOS rules
 * @param {string} username - Username to validate
 * @returns {Object} Validation result
 */
export const validateUsername = username => {
  if (!username || typeof username !== 'string') {
    return { valid: false, message: 'Username is required and must be a string' };
  }

  // OmniOS username rules: start with letter or underscore, followed by letters, numbers, underscore, hyphen
  const usernameRegex = /^[a-z_][a-z0-9_-]*$/;
  if (!usernameRegex.test(username)) {
    return {
      valid: false,
      message:
        'Username must start with a letter or underscore, and contain only lowercase letters, numbers, underscores, and hyphens',
    };
  }

  return { valid: true };
};

/**
 * Validate UID according to OmniOS ranges
 * @param {number} uid - UID to validate
 * @returns {Object} Validation result
 */
export const validateUID = uid => {
  if (uid === undefined || uid === null) {
    return { valid: true }; // Optional parameter
  }

  const uidNum = parseInt(uid);
  if (isNaN(uidNum)) {
    return { valid: false, message: 'UID must be a number' };
  }

  if (uidNum < 0 || uidNum > 2147483647) {
    return { valid: false, message: 'UID must be between 0 and 2147483647' };
  }

  if (uidNum >= 0 && uidNum <= 99) {
    return {
      valid: true,
      warning: `UID ${uidNum} is in the system reserved range (0-99)`,
    };
  }

  return { valid: true };
};

/**
 * Validate group name format
 * @param {string} groupname - Group name to validate
 * @returns {Object} Validation result
 */
export const validateGroupName = groupname => {
  if (!groupname || typeof groupname !== 'string') {
    return { valid: false, message: 'Group name is required and must be a string' };
  }

  // Similar rules to username but allow uppercase
  const groupRegex = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
  if (!groupRegex.test(groupname)) {
    return {
      valid: false,
      message:
        'Group name must start with a letter or underscore, and contain only letters, numbers, underscores, and hyphens',
    };
  }

  return { valid: true };
};

/**
 * Validate arrays for RBAC parameters
 * @param {string} fieldName - Name of the field being validated
 * @param {*} value - Value to validate
 * @returns {Object} Validation result
 */
export const validateRBACArray = (fieldName, value) => {
  if (value && !Array.isArray(value)) {
    return {
      valid: false,
      message: `${fieldName} must be an array`,
    };
  }
  return { valid: true };
};

/**
 * Validate that conflicting ZFS options are not both set
 * @param {boolean} forceZfs - Force ZFS option
 * @param {boolean} preventZfs - Prevent ZFS option
 * @returns {Object} Validation result
 */
export const validateZFSOptions = (forceZfs, preventZfs) => {
  if (forceZfs && preventZfs) {
    return {
      valid: false,
      message: 'Cannot specify both force_zfs and prevent_zfs',
    };
  }
  return { valid: true };
};
