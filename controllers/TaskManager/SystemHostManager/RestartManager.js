/**
 * @fileoverview System Host Restart Manager
 * @description Executes system restart operations for TaskQueue
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import yj from 'yieldable-json';
import config from '../../../config/ConfigLoader.js';
import { executeCommand } from '../../../lib/CommandManager.js';
import { log, createTimer } from '../../../lib/Logger.js';
import { clearRebootRequired } from '../../../lib/RebootManager.js';
import { executeZoneShutdownOrchestration } from '../../../lib/ZoneOrchestrationManager.js';

const COMMAND_TIMEOUT_MS = (config.get('system_host.command_timeout_seconds') || 300) * 1000;

/**
 * Execute system host restart task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeSystemHostRestartTask = async metadataJson => {
  const taskTimer = createTimer('system_host_restart');

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
      grace_period = 60,
      message = '',
      method = 'graceful_shutdown',
      zone_orchestration = null,
    } = metadata;

    log.monitoring.warn('SYSTEM RESTART: Task execution started', {
      grace_period,
      message,
      method,
      zone_orchestration_enabled: !!zone_orchestration?.enabled,
    });

    // PHASE 1: Zone Orchestration (if enabled)
    if (zone_orchestration?.enabled) {
      log.monitoring.warn('SYSTEM RESTART: Starting zone shutdown orchestration');

      const orchestrationResult = await executeZoneShutdownOrchestration(
        zone_orchestration.strategy || 'parallel_by_priority',
        {
          failure_action: zone_orchestration.failure_action || 'abort',
          priority_delay: zone_orchestration.priority_delay || 30,
          zone_timeout: zone_orchestration.zone_timeout || 120,
        }
      );

      if (!orchestrationResult.success) {
        if (zone_orchestration.failure_action === 'abort') {
          log.monitoring.error('SYSTEM RESTART: Aborting due to zone orchestration failure', {
            zones_failed: orchestrationResult.zones_failed,
          });
          return {
            success: false,
            error: `Zone orchestration failed: ${orchestrationResult.error}`,
            details: {
              zones_stopped: orchestrationResult.zones_stopped || [],
              zones_failed: orchestrationResult.zones_failed || [],
            },
          };
        }
        log.monitoring.warn('SYSTEM RESTART: Continuing despite zone orchestration failures', {
          zones_failed: orchestrationResult.zones_failed,
          failure_action: zone_orchestration.failure_action,
        });
      } else {
        log.monitoring.info('SYSTEM RESTART: Zone orchestration completed successfully', {
          zones_stopped: orchestrationResult.zones_stopped?.length || 0,
        });
      }
    }

    let command;
    if (method === 'graceful_shutdown') {
      // Use shutdown command for graceful restart
      command = `pfexec shutdown -y -i 6 -g ${grace_period}`;
      if (message) {
        command += ` "${message}"`;
      }
    } else {
      // Fallback to direct reboot
      command = 'pfexec reboot';
    }

    log.monitoring.warn('SYSTEM RESTART: Executing restart command', {
      command: command.substring(0, 100),
      grace_period,
    });

    // Clear reboot flags since we're about to restart
    try {
      await clearRebootRequired('system_restart_initiated');
      log.monitoring.info('Reboot flags cleared before system restart');
    } catch (error) {
      log.monitoring.warn('Failed to clear reboot flags before restart', {
        error: error.message,
      });
    }

    // Execute the restart command
    const result = await executeCommand(command, COMMAND_TIMEOUT_MS);

    const duration = taskTimer.end();

    if (result.success) {
      log.monitoring.warn('SYSTEM RESTART: Command executed successfully', {
        duration_ms: duration,
        grace_period,
      });
      return {
        success: true,
        message: `System restart initiated successfully with ${grace_period} second grace period`,
      };
    }
    log.monitoring.error('SYSTEM RESTART: Command failed', {
      error: result.error,
      duration_ms: duration,
    });
    return {
      success: false,
      error: `System restart failed: ${result.error}`,
    };
  } catch (error) {
    taskTimer.end();
    log.monitoring.error('SYSTEM RESTART: Task execution failed', {
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      error: `System restart task failed: ${error.message}`,
    };
  }
};

/**
 * Execute system host reboot task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeSystemHostRebootTask = async metadataJson => {
  const taskTimer = createTimer('system_host_reboot');

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

    const { dump_core = false, method = 'direct_reboot' } = metadata;

    log.monitoring.warn('SYSTEM REBOOT: Task execution started', {
      dump_core,
      method,
    });

    let command = 'pfexec reboot';
    if (dump_core) {
      command += ' -d'; // Force crash dump before reboot
    }

    log.monitoring.warn('SYSTEM REBOOT: Executing reboot command', {
      command,
      dump_core,
    });

    // Clear reboot flags since we're about to reboot
    try {
      await clearRebootRequired('system_reboot_initiated');
      log.monitoring.info('Reboot flags cleared before system reboot');
    } catch (error) {
      log.monitoring.warn('Failed to clear reboot flags before reboot', {
        error: error.message,
      });
    }

    // Execute the reboot command
    const result = await executeCommand(command, COMMAND_TIMEOUT_MS);

    const duration = taskTimer.end();

    if (result.success) {
      log.monitoring.warn('SYSTEM REBOOT: Command executed successfully', {
        duration_ms: duration,
        dump_core,
      });
      return {
        success: true,
        message: 'System reboot initiated successfully',
      };
    }
    log.monitoring.error('SYSTEM REBOOT: Command failed', {
      error: result.error,
      duration_ms: duration,
    });
    return {
      success: false,
      error: `System reboot failed: ${result.error}`,
    };
  } catch (error) {
    taskTimer.end();
    log.monitoring.error('SYSTEM REBOOT: Task execution failed', {
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      error: `System reboot task failed: ${error.message}`,
    };
  }
};

/**
 * Execute system host fast reboot task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeSystemHostRebootFastTask = async metadataJson => {
  const taskTimer = createTimer('system_host_reboot_fast');

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

    const { boot_environment } = metadata;

    log.monitoring.warn('SYSTEM FAST REBOOT: Task execution started', {
      boot_environment,
    });

    let command = 'pfexec reboot -f';
    if (boot_environment) {
      command += ` -e ${boot_environment}`;
    }

    log.monitoring.warn('SYSTEM FAST REBOOT: Executing fast reboot command', {
      command,
      boot_environment,
    });

    // Clear reboot flags since we're about to reboot
    try {
      await clearRebootRequired('system_fast_reboot_initiated');
      log.monitoring.info('Reboot flags cleared before system fast reboot');
    } catch (error) {
      log.monitoring.warn('Failed to clear reboot flags before fast reboot', {
        error: error.message,
      });
    }

    // Execute the fast reboot command
    const result = await executeCommand(command, COMMAND_TIMEOUT_MS);

    const duration = taskTimer.end();

    if (result.success) {
      log.monitoring.warn('SYSTEM FAST REBOOT: Command executed successfully', {
        duration_ms: duration,
        boot_environment,
      });
      return {
        success: true,
        message: 'System fast reboot initiated successfully',
      };
    }
    log.monitoring.error('SYSTEM FAST REBOOT: Command failed', {
      error: result.error,
      duration_ms: duration,
    });
    return {
      success: false,
      error: `System fast reboot failed: ${result.error}`,
    };
  } catch (error) {
    taskTimer.end();
    log.monitoring.error('SYSTEM FAST REBOOT: Task execution failed', {
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      error: `System fast reboot task failed: ${error.message}`,
    };
  }
};
