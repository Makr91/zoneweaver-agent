/**
 * @fileoverview System Validation Utilities for Host Management
 * @description Safety checks and validation for system operations
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { log } from '../../../lib/Logger.js';

/**
 * Valid init runlevels for OmniOS
 */
export const VALID_RUNLEVELS = ['0', '1', '2', '3', '4', '5', '6', 's', 'S'];

/**
 * Runlevel descriptions
 */
export const RUNLEVEL_DESCRIPTIONS = {
  0: 'Halt/Power off system',
  1: 'Single-user administrative mode',
  2: 'Multi-user mode',
  3: 'Multi-user mode with network services',
  4: 'Alternative multi-user mode (unused)',
  5: 'Power off',
  6: 'Reboot',
  s: 'Single-user mode',
  S: 'Single-user mode',
};

/**
 * Validate grace period for shutdown operations
 * @param {number} gracePeriod - Grace period in seconds
 * @returns {{valid: boolean, error?: string, normalizedValue?: number}}
 */
export const validateGracePeriod = gracePeriod => {
  if (gracePeriod === undefined || gracePeriod === null) {
    return { valid: true, normalizedValue: 60 }; // Default 60 seconds
  }

  const parsed = parseInt(gracePeriod);
  if (isNaN(parsed)) {
    return { valid: false, error: 'Grace period must be a number' };
  }

  if (parsed < 0) {
    return { valid: false, error: 'Grace period cannot be negative' };
  }

  if (parsed > 7200) {
    return { valid: false, error: 'Grace period cannot exceed 2 hours (7200 seconds)' };
  }

  return { valid: true, normalizedValue: parsed };
};

/**
 * Validate runlevel
 * @param {string} runlevel - Target runlevel
 * @returns {{valid: boolean, error?: string, normalizedValue?: string}}
 */
export const validateRunlevel = runlevel => {
  if (!runlevel) {
    return { valid: false, error: 'Runlevel is required' };
  }

  const level = runlevel.toString().toLowerCase();
  if (!VALID_RUNLEVELS.map(l => l.toLowerCase()).includes(level)) {
    return {
      valid: false,
      error: `Invalid runlevel '${runlevel}'. Valid levels: ${VALID_RUNLEVELS.join(', ')}`,
    };
  }

  return { valid: true, normalizedValue: level };
};

/**
 * Validate custom warning message
 * @param {string} message - Warning message
 * @returns {{valid: boolean, error?: string, normalizedValue?: string}}
 */
export const validateWarningMessage = message => {
  if (!message) {
    return { valid: true, normalizedValue: '' };
  }

  if (typeof message !== 'string') {
    return { valid: false, error: 'Message must be a string' };
  }

  if (message.length > 200) {
    return { valid: false, error: 'Message cannot exceed 200 characters' };
  }

  // Sanitize for shell safety
  const sanitized = message.replace(/['"\\]/g, '');
  return { valid: true, normalizedValue: sanitized };
};

/**
 * Check if operation is safe to perform
 * @param {string} operation - Operation name
 * @param {Object} options - Operation options
 * @returns {{safe: boolean, warnings: Array<string>, blockers: Array<string>}}
 */
export const checkOperationSafety = (operation, options = {}) => {
  const warnings = [];
  const blockers = [];

  // Check for destructive operations
  if (['restart', 'shutdown', 'reboot', 'poweroff', 'halt'].includes(operation)) {
    warnings.push('This operation will interrupt all system services and user sessions');

    if (options.force) {
      warnings.push('Force flag specified - normal shutdown procedures may be bypassed');
    }

    if (options.gracePeriod === 0) {
      warnings.push('Zero grace period - immediate operation with no user warning');
    }
  }

  // Check for runlevel changes
  if (operation === 'runlevel_change') {
    const { targetLevel } = options;
    if (['0', '5'].includes(targetLevel)) {
      warnings.push('Target runlevel will power off the system');
    } else if (targetLevel === '6') {
      warnings.push('Target runlevel will reboot the system');
    } else if (['s', 'S', '1'].includes(targetLevel)) {
      warnings.push('Target runlevel will terminate user sessions and network services');
    }
  }

  // Log safety check
  log.monitoring.info('System operation safety check performed', {
    operation,
    options,
    warnings_count: warnings.length,
    blockers_count: blockers.length,
  });

  return {
    safe: blockers.length === 0,
    warnings,
    blockers,
  };
};
