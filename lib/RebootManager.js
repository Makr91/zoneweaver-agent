/**
 * @fileoverview Reboot Flag Management Utility for Zoneweaver Agent
 * @description Manages system reboot required flags across components
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import fs from 'fs/promises';
import os from 'os';
import { log } from './Logger.js';

const REBOOT_FLAG_PATH = '/var/tmp/zoneweaver-reboot-required';

/**
 * Set reboot required flag with reason
 * @param {string} reason - Reason for reboot requirement
 * @param {string} component - Component that triggered the requirement
 */
export const setRebootRequired = async (reason, component = 'api') => {
  try {
    let existingData = {
      timestamp: new Date().toISOString(),
      reasons: [],
      created_by: component,
    };

    // Try to read existing flag file
    try {
      const existingContent = await fs.readFile(REBOOT_FLAG_PATH, 'utf8');
      existingData = JSON.parse(existingContent);
    } catch {
      // File doesn't exist or is invalid, use new data
    }

    // Add new reason if not already present
    if (!existingData.reasons.includes(reason)) {
      existingData.reasons.push(reason);
    }

    // Update timestamp to most recent change
    existingData.timestamp = new Date().toISOString();

    await fs.writeFile(REBOOT_FLAG_PATH, JSON.stringify(existingData, null, 2));
    log.monitoring.info('Reboot flag set', {
      reason,
      component,
      existing_reasons: existingData.reasons,
    });
  } catch (error) {
    log.monitoring.error('Error setting reboot flag', {
      error: error.message,
      reason,
      component,
    });
    // Don't throw - this is not critical enough to fail the main operation
  }
};

/**
 * Check if reboot is required
 * @returns {Object} Reboot status information
 */
export const getRebootStatus = async () => {
  try {
    const flagContent = await fs.readFile(REBOOT_FLAG_PATH, 'utf8');
    const flagData = JSON.parse(flagContent);

    return {
      reboot_required: true,
      timestamp: flagData.timestamp,
      reasons: flagData.reasons || [],
      created_by: flagData.created_by || 'unknown',
      age_minutes: Math.round((Date.now() - new Date(flagData.timestamp).getTime()) / (1000 * 60)),
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        reboot_required: false,
        timestamp: null,
        reasons: [],
        created_by: null,
        age_minutes: 0,
      };
    }

    log.monitoring.error('Error reading reboot flag', {
      error: error.message,
    });
    return {
      reboot_required: false,
      timestamp: null,
      reasons: [],
      created_by: null,
      age_minutes: 0,
      error: 'Failed to read reboot flag',
    };
  }
};

/**
 * Clear reboot required flag
 * @param {string} reason - Optional reason for clearing
 */
export const clearRebootRequired = async (reason = 'manual') => {
  try {
    await fs.unlink(REBOOT_FLAG_PATH);
    log.monitoring.info('Reboot flag cleared', {
      reason,
    });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log.monitoring.error('Error clearing reboot flag', {
        error: error.message,
        reason,
      });
    }
    // If file doesn't exist, that's fine - already cleared
  }
};

/**
 * Check if system has rebooted since flag was created and cleanup if so
 * Should be called during service startup
 */
export const checkAndClearAfterReboot = async () => {
  try {
    const rebootStatus = await getRebootStatus();

    if (!rebootStatus.reboot_required) {
      return { action: 'none', reason: 'No reboot flag present' };
    }

    // Get system uptime in milliseconds
    const uptimeMs = os.uptime() * 1000;
    const currentTime = Date.now();
    const systemBootTime = currentTime - uptimeMs;

    // Get flag creation time
    const flagTime = new Date(rebootStatus.timestamp).getTime();

    // If flag was created before the system boot time, system has rebooted
    if (flagTime < systemBootTime) {
      await clearRebootRequired('system_rebooted');
      return {
        action: 'cleared',
        reason: 'System rebooted since flag was created',
        flag_time: rebootStatus.timestamp,
        boot_time: new Date(systemBootTime).toISOString(),
        reasons_cleared: rebootStatus.reasons,
      };
    }

    return {
      action: 'kept',
      reason: 'System has not rebooted since flag was created',
      flag_age_minutes: rebootStatus.age_minutes,
    };
  } catch (error) {
    log.monitoring.error('Error checking reboot flag on startup', {
      error: error.message,
    });
    return {
      action: 'error',
      reason: error.message,
    };
  }
};

/**
 * Remove a specific reason from reboot flag
 * If no reasons remain, clear the flag entirely
 * @param {string} reason - Reason to remove
 */
export const removeRebootReason = async reason => {
  try {
    const rebootStatus = await getRebootStatus();

    if (!rebootStatus.reboot_required) {
      return { action: 'none', reason: 'No reboot flag present' };
    }

    // Remove the specific reason
    const updatedReasons = rebootStatus.reasons.filter(r => r !== reason);

    if (updatedReasons.length === 0) {
      // No reasons left, clear flag entirely
      await clearRebootRequired('no_reasons_remaining');
      return { action: 'cleared', reason: 'No reasons remaining' };
    }

    // Update flag with remaining reasons
    const flagData = {
      timestamp: rebootStatus.timestamp, // Keep original timestamp
      reasons: updatedReasons,
      created_by: rebootStatus.created_by,
    };

    await fs.writeFile(REBOOT_FLAG_PATH, JSON.stringify(flagData, null, 2));

    return {
      action: 'updated',
      reason: 'Specific reason removed',
      removed_reason: reason,
      remaining_reasons: updatedReasons,
    };
  } catch (error) {
    log.monitoring.error('Error removing reboot reason', {
      error: error.message,
      reason,
    });
    return {
      action: 'error',
      reason: error.message,
    };
  }
};
