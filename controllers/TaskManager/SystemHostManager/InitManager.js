/**
 * @fileoverview System Host Init Manager
 * @description Executes system runlevel changes for TaskQueue
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import yj from 'yieldable-json';
import { executeCommand } from '../../../lib/CommandManager.js';
import { log, createTimer } from '../../../lib/Logger.js';

/**
 * Execute system host runlevel change task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeSystemHostRunlevelChangeTask = async metadataJson => {
  const taskTimer = createTimer('system_host_runlevel_change');

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

    const { target_runlevel, method = 'init_command' } = metadata;

    log.monitoring.warn('SYSTEM RUNLEVEL CHANGE: Task execution started', {
      target_runlevel,
      method,
    });

    let command;
    if (method === 'init_command') {
      command = `pfexec init ${target_runlevel}`;
    } else {
      // Fallback method
      command = `pfexec telinit ${target_runlevel}`;
    }

    log.monitoring.warn('SYSTEM RUNLEVEL CHANGE: Executing runlevel change command', {
      command,
      target_runlevel,
    });

    // Get current runlevel before change for logging
    let currentRunlevel = 'unknown';
    try {
      const whoResult = await executeCommand('who -r');
      if (whoResult.success) {
        const match = whoResult.output.match(/run-level (?<level>\w)/);
        if (match) {
          currentRunlevel = match.groups.level;
        }
      }
    } catch (error) {
      log.monitoring.warn('Failed to get current runlevel before change', {
        error: error.message,
      });
    }

    // Execute the runlevel change command
    const result = await executeCommand(command, 180000); // 3 min timeout

    const duration = taskTimer.end();

    if (result.success) {
      log.monitoring.warn('SYSTEM RUNLEVEL CHANGE: Command executed successfully', {
        duration_ms: duration,
        from_runlevel: currentRunlevel,
        to_runlevel: target_runlevel,
      });
      return {
        success: true,
        message: `System runlevel changed from ${currentRunlevel} to ${target_runlevel} successfully`,
      };
    }
    log.monitoring.error('SYSTEM RUNLEVEL CHANGE: Command failed', {
      error: result.error,
      duration_ms: duration,
      target_runlevel,
    });
    return {
      success: false,
      error: `System runlevel change failed: ${result.error}`,
    };
  } catch (error) {
    taskTimer.end();
    log.monitoring.error('SYSTEM RUNLEVEL CHANGE: Task execution failed', {
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      error: `System runlevel change task failed: ${error.message}`,
    };
  }
};
