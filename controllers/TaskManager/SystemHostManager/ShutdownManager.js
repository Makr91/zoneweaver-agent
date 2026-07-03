/**
 * @fileoverview System Host Shutdown Manager
 * @description Executes system shutdown operations for TaskQueue
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import yj from 'yieldable-json';
import { executeCommand } from '../../../lib/CommandManager.js';
import { log, createTimer } from '../../../lib/Logger.js';
import { executeZoneShutdownOrchestration } from '../../../lib/ZoneOrchestrationManager.js';

/**
 * Execute system host shutdown task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeSystemHostShutdownTask = async metadataJson => {
  const taskTimer = createTimer('system_host_shutdown');

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
      target_state = 's',
      zone_orchestration = null,
    } = metadata;

    log.monitoring.warn('SYSTEM SHUTDOWN: Task execution started', {
      grace_period,
      message,
      target_state,
      zone_orchestration_enabled: !!zone_orchestration?.enabled,
    });

    // PHASE 1: Zone Orchestration (if enabled)
    if (zone_orchestration?.enabled) {
      log.monitoring.warn('SYSTEM SHUTDOWN: Starting zone shutdown orchestration');

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
          log.monitoring.error('SYSTEM SHUTDOWN: Aborting due to zone orchestration failure', {
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
        log.monitoring.warn('SYSTEM SHUTDOWN: Continuing despite zone orchestration failures', {
          zones_failed: orchestrationResult.zones_failed,
          failure_action: zone_orchestration.failure_action,
        });
      } else {
        log.monitoring.info('SYSTEM SHUTDOWN: Zone orchestration completed successfully', {
          zones_stopped: orchestrationResult.zones_stopped?.length || 0,
        });
      }
    }

    let command = `pfexec shutdown -y -i ${target_state} -g ${grace_period}`;
    if (message) {
      command += ` "${message}"`;
    }

    log.monitoring.warn('SYSTEM SHUTDOWN: Executing shutdown command', {
      command: command.substring(0, 100),
      grace_period,
      target_state,
    });

    // Execute the shutdown command
    const result = await executeCommand(command, 300000); // 5 min timeout ## SHOULD NOT BE HARDCODED, ALL LIMITS SHOULD BE CONFIGURATION IN THE CONFIG.YML

    const duration = taskTimer.end();

    if (result.success) {
      log.monitoring.warn('SYSTEM SHUTDOWN: Command executed successfully', {
        duration_ms: duration,
        grace_period,
        target_state,
      });
      return {
        success: true,
        message: `System shutdown initiated successfully with ${grace_period} second grace period`,
      };
    }
    log.monitoring.error('SYSTEM SHUTDOWN: Command failed', {
      error: result.error,
      duration_ms: duration,
    });
    return {
      success: false,
      error: `System shutdown failed: ${result.error}`,
    };
  } catch (error) {
    taskTimer.end();
    log.monitoring.error('SYSTEM SHUTDOWN: Task execution failed', {
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      error: `System shutdown task failed: ${error.message}`,
    };
  }
};

/**
 * Execute system host poweroff task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeSystemHostPoweroffTask = async metadataJson => {
  const taskTimer = createTimer('system_host_poweroff');

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

    const { grace_period = 60, message = '', zone_orchestration = null } = metadata;

    log.monitoring.warn('SYSTEM POWEROFF: Task execution started', {
      grace_period,
      message,
      zone_orchestration_enabled: !!zone_orchestration?.enabled,
    });

    // PHASE 1: Zone Orchestration (if enabled)
    if (zone_orchestration?.enabled) {
      log.monitoring.warn('SYSTEM POWEROFF: Starting zone shutdown orchestration');

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
          log.monitoring.error('SYSTEM POWEROFF: Aborting due to zone orchestration failure', {
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
        log.monitoring.warn('SYSTEM POWEROFF: Continuing despite zone orchestration failures', {
          zones_failed: orchestrationResult.zones_failed,
          failure_action: zone_orchestration.failure_action,
        });
      } else {
        log.monitoring.info('SYSTEM POWEROFF: Zone orchestration completed successfully', {
          zones_stopped: orchestrationResult.zones_stopped?.length || 0,
        });
      }
    }

    let command = `pfexec shutdown -y -i 5 -g ${grace_period}`;
    if (message) {
      command += ` "${message}"`;
    }

    log.monitoring.warn('SYSTEM POWEROFF: Executing poweroff command', {
      command: command.substring(0, 100),
      grace_period,
    });

    // Execute the poweroff command
    const result = await executeCommand(command, 300000); // 5 min timeout

    const duration = taskTimer.end();

    if (result.success) {
      log.monitoring.warn('SYSTEM POWEROFF: Command executed successfully', {
        duration_ms: duration,
        grace_period,
      });
      return {
        success: true,
        message: `System poweroff initiated successfully with ${grace_period} second grace period`,
      };
    }
    log.monitoring.error('SYSTEM POWEROFF: Command failed', {
      error: result.error,
      duration_ms: duration,
    });
    return {
      success: false,
      error: `System poweroff failed: ${result.error}`,
    };
  } catch (error) {
    taskTimer.end();
    log.monitoring.error('SYSTEM POWEROFF: Task execution failed', {
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      error: `System poweroff task failed: ${error.message}`,
    };
  }
};

/**
 * Execute system host halt task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeSystemHostHaltTask = async metadataJson => {
  const taskTimer = createTimer('system_host_halt');

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

    const { emergency = false } = metadata;

    log.monitoring.error('EMERGENCY SYSTEM HALT: Task execution started', {
      emergency,
    });

    const command = 'pfexec halt';

    log.monitoring.error('EMERGENCY SYSTEM HALT: Executing halt command', {
      command,
      emergency,
    });

    // Execute the halt command
    const result = await executeCommand(command, 30000); // 30 sec timeout for halt

    const duration = taskTimer.end();

    if (result.success) {
      log.monitoring.error('EMERGENCY SYSTEM HALT: Command executed successfully', {
        duration_ms: duration,
        emergency,
      });
      return {
        success: true,
        message: 'System halt initiated successfully',
      };
    }
    log.monitoring.error('EMERGENCY SYSTEM HALT: Command failed', {
      error: result.error,
      duration_ms: duration,
    });
    return {
      success: false,
      error: `System halt failed: ${result.error}`,
    };
  } catch (error) {
    taskTimer.end();
    log.monitoring.error('EMERGENCY SYSTEM HALT: Task execution failed', {
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      error: `System halt task failed: ${error.message}`,
    };
  }
};
