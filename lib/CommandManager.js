import { spawn } from 'child_process';
import config from '../config/ConfigLoader.js';
import { log, createTimer } from './Logger.js';
import { registerTaskChild } from './TaskContext.js';

/**
 * Default command timeout in milliseconds (zones.task_timeout).
 */
export const TASK_TIMEOUT = (config.getZones()?.task_timeout || 300) * 1000;

/**
 * Execute a zone command asynchronously
 * @param {string} command - Command to execute
 * @param {number} timeout - Timeout in milliseconds
 * @param {Function} [onData] - Live output callback ({stream, data})
 * @param {string} [input] - Data written to the child's stdin then closed —
 *   secrets ride this instead of the command line (never in ps, never shell-parsed)
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
export const executeCommand = (command, timeout = TASK_TIMEOUT, onData = null, input = null) => {
  const timer = createTimer(`executeCommand: ${command.substring(0, 50)}`);

  return new Promise(resolve => {
    const child = spawn('sh', ['-c', command], {
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    // A running-task cancel kills registered children (TaskState controls).
    const deregisterChild = registerTaskChild(child);

    if (input !== null) {
      // EPIPE guard: a command that exits before reading stdin must not crash
      // the process — the close handler still reports its real exit.
      child.stdin.on('error', () => {});
      child.stdin.write(input);
      child.stdin.end();
    }

    let stdout = '';
    let stderr = '';
    let completed = false;

    // Set up timeout
    const timeoutId = setTimeout(() => {
      if (!completed) {
        completed = true;
        child.kill('SIGTERM');
        log.task.error('Command execution timeout', {
          command: command.substring(0, 100),
          timeout_ms: timeout,
          stdout_preview: stdout.substring(0, 200),
        });
        timer.end();
        resolve({
          success: false,
          error: `Command timed out after ${timeout}ms`,
          output: stdout,
        });
      }
    }, timeout);

    // Collect output
    child.stdout.on('data', data => {
      const chunk = data.toString();
      stdout += chunk;
      if (onData) {
        onData({ stream: 'stdout', data: chunk });
      }
    });

    child.stderr.on('data', data => {
      const chunk = data.toString();
      stderr += chunk;
      if (onData) {
        onData({ stream: 'stderr', data: chunk });
      }
    });

    // Handle completion
    child.on('close', code => {
      deregisterChild();
      if (!completed) {
        completed = true;
        clearTimeout(timeoutId);
        const duration = timer.end();

        if (code === 0) {
          // Log performance info if command took >1000ms
          if (duration > 1000) {
            log.performance.info('Slow command execution', {
              command: command.substring(0, 100),
              duration_ms: duration,
              stdout_size: stdout.length,
            });
          }
          resolve({
            success: true,
            output: stdout.trim(),
          });
        } else {
          log.task.error('Command execution failed', {
            command: command.substring(0, 100),
            exit_code: code,
            stderr: stderr.trim().substring(0, 200),
            duration_ms: duration,
          });
          resolve({
            success: false,
            error: stderr.trim() || `Command exited with code ${code}`,
            output: stdout.trim(),
          });
        }
      }
    });

    // Handle errors
    child.on('error', error => {
      deregisterChild();
      if (!completed) {
        completed = true;
        clearTimeout(timeoutId);
        const duration = timer.end();
        log.task.error('Command execution error', {
          command: command.substring(0, 100),
          error: error.message,
          duration_ms: duration,
        });
        resolve({
          success: false,
          error: error.message,
          output: stdout,
        });
      }
    });
  });
};
