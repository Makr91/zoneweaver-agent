/**
 * @fileoverview Timezone Task Manager for Time Synchronization Operations
 * @description Handles system timezone setting
 */

import { parseAsync } from '../../../lib/AsyncJson.js';
import { executeCommand } from '../../../lib/CommandManager.js';
import { setRebootRequired } from '../../../lib/RebootManager.js';
import { log } from '../../../lib/Logger.js';

/**
 * Execute timezone setting task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeSetTimezoneTask = async metadataJson => {
  log.task.debug('Set timezone task starting');

  try {
    const metadata = await parseAsync(metadataJson);
    const { timezone, backup_existing } = metadata;

    log.task.debug('Set timezone parameters', {
      timezone,
      backup_existing,
    });

    const configFile = '/etc/default/init';

    // Validate timezone exists
    const zonePath = `/usr/share/lib/zoneinfo/${timezone}`;
    const validateResult = await executeCommand(`test -f ${zonePath}`);
    if (!validateResult.success) {
      return {
        success: false,
        error: `Invalid timezone: ${timezone} - timezone file not found at ${zonePath}`,
      };
    }

    log.task.debug('Timezone validated successfully');

    // Create backup if requested
    if (backup_existing) {
      const backupResult = await executeCommand(
        `pfexec cp ${configFile} ${configFile}.backup.$(date +%Y%m%d_%H%M%S)`
      );
      if (backupResult.success) {
        log.task.debug('Config backup created');
      } else {
        log.task.warn('Failed to create backup', {
          error: backupResult.error,
        });
      }
    }

    // Read current config
    const readResult = await executeCommand(`cat ${configFile}`);
    if (!readResult.success) {
      return {
        success: false,
        error: `Failed to read config file ${configFile}: ${readResult.error}`,
      };
    }

    // Update timezone in config
    let configContent = readResult.output;
    const tzPattern = /^TZ=.*$/m;

    if (tzPattern.test(configContent)) {
      // Replace existing TZ line
      configContent = configContent.replace(tzPattern, `TZ=${timezone}`);
      log.task.debug('Updated existing TZ line');
    } else {
      // Add TZ line
      configContent += `\nTZ=${timezone}\n`;
      log.task.debug('Added new TZ line');
    }

    // Write updated config
    const writeResult = await executeCommand(
      `echo '${configContent.replace(/'/g, "'\\''")}' | pfexec tee ${configFile}`
    );

    if (!writeResult.success) {
      return {
        success: false,
        error: `Failed to write config file ${configFile}: ${writeResult.error}`,
      };
    }

    log.task.info('Timezone config written successfully', { configFile });

    // Set reboot required flag
    await setRebootRequired('timezone_change', 'TaskQueue');

    // Verify the change
    const verifyResult = await executeCommand(`grep "^TZ=" ${configFile}`);
    const verifiedTz = verifyResult.success ? verifyResult.output : 'unknown';

    return {
      success: true,
      message: `Timezone set to ${timezone} successfully (reboot required for full effect)`,
      config_file: configFile,
      verified_setting: verifiedTz,
      requires_reboot: true,
      reboot_reason: 'Timezone change in /etc/default/init requires system reboot to take effect',
    };
  } catch (error) {
    log.task.error('Set timezone task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Set timezone task failed: ${error.message}` };
  }
};
