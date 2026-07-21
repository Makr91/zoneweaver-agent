/**
 * @fileoverview Time Sync Task Manager for Time Synchronization Operations
 * @description Handles time sync configuration updates and forced time synchronization
 */

import { parseAsync } from '../../../lib/AsyncJson.js';
import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';

/**
 * Execute time sync configuration update task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeUpdateTimeSyncConfigTask = async metadataJson => {
  log.task.debug('Time sync config update task starting');

  try {
    const metadata = await parseAsync(metadataJson);
    const { service, config_content, backup_existing, restart_service } = metadata;

    log.task.debug('Time sync config update parameters', {
      service,
      backup_existing,
      restart_service,
      config_content_length: config_content ? config_content.length : 0,
    });

    // Determine config file path based on service
    let configFile;
    if (service === 'ntp') {
      configFile = '/etc/inet/ntp.conf';
    } else if (service === 'chrony') {
      configFile = '/etc/inet/chrony.conf';
    } else {
      return { success: false, error: `Unknown time sync service: ${service}` };
    }

    log.task.debug('Target config file', { configFile });

    // Create backup if existing config exists and backup is requested
    if (backup_existing) {
      const backupResult = await executeCommand(
        `test -f ${configFile} && pfexec cp ${configFile} ${configFile}.backup.$(date +%Y%m%d_%H%M%S) || echo "No existing config to backup"`
      );
      if (backupResult.success) {
        log.task.debug('Config backup created (if file existed)');
      } else {
        log.task.warn('Failed to create backup', {
          error: backupResult.error,
        });
      }
    }

    // Write new config content
    const writeResult = await executeCommand(
      `echo '${config_content.replace(/'/g, "'\\''")}' | pfexec tee ${configFile}`
    );

    if (!writeResult.success) {
      return {
        success: false,
        error: `Failed to write config file ${configFile}: ${writeResult.error}`,
      };
    }

    log.task.info('Config file written successfully', { configFile });

    // Restart service if requested
    if (restart_service) {
      log.task.debug('Restarting service', { service });
      const restartResult = await executeCommand(`pfexec svcadm restart network/${service}`);

      if (!restartResult.success) {
        return {
          success: true, // Config was written successfully
          message: `Time sync configuration updated successfully, but service restart failed: ${restartResult.error}`,
          warning: `Service ${service} restart failed - may need manual restart`,
        };
      }
      log.task.info('Service restarted successfully', { service });
    }

    return {
      success: true,
      message: `Time sync configuration updated successfully for ${service}${restart_service ? ' (service restarted)' : ''}`,
      config_file: configFile,
    };
  } catch (error) {
    log.task.error('Time sync config update task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Time sync config update task failed: ${error.message}` };
  }
};

/**
 * Execute force time synchronization task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeForceTimeSyncTask = async metadataJson => {
  log.task.debug('Force time sync task starting');

  try {
    const metadata = await parseAsync(metadataJson);
    const { service, server, timeout } = metadata;

    log.task.debug('Force time sync parameters', {
      service,
      server: server || 'auto-detect',
      timeout,
    });

    let syncResult;

    if (service === 'ntp') {
      // For NTP, use ntpdig for immediate sync
      let command = `pfexec ntpdig`;
      if (timeout) {
        command += ` -t ${timeout}`;
      }
      if (server) {
        command += ` ${server}`;
      } else {
        command += ` pool.ntp.org`; // Default fallback server
      }

      log.task.debug('Executing NTP sync command', { command });
      syncResult = await executeCommand(command, (timeout || 30) * 1000);
    } else if (service === 'chrony') {
      // For Chrony, use chronyc to force sync
      log.task.debug('Executing Chrony makestep command');
      syncResult = await executeCommand(`pfexec chronyc makestep`, (timeout || 30) * 1000);

      if (!syncResult.success) {
        // Fallback to burst command
        log.task.debug('Makestep failed, trying burst command');
        syncResult = await executeCommand(`pfexec chronyc burst 5/10`, (timeout || 30) * 1000);
      }
    } else {
      return { success: false, error: `Cannot force sync - unknown service: ${service}` };
    }

    if (syncResult.success) {
      log.task.info('Time sync command completed successfully');

      // Get current system time for confirmation
      const timeResult = await executeCommand('date');
      const currentTime = timeResult.success ? timeResult.output : 'unknown';

      return {
        success: true,
        message: `Time synchronization completed successfully using ${service}${server ? ` (server: ${server})` : ''}`,
        current_time: currentTime,
        sync_output: syncResult.output,
      };
    }
    log.task.error('Time sync command failed', {
      error: syncResult.error,
    });
    return {
      success: false,
      error: `Time synchronization failed: ${syncResult.error}`,
    };
  } catch (error) {
    log.task.error('Force time sync task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Force time sync task failed: ${error.message}` };
  }
};
