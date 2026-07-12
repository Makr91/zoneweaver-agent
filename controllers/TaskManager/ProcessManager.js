import yj from 'yieldable-json';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';

/**
 * Process Manager for Process Operations
 * Handles process tracing functionality
 */

/**
 * Execute process trace task
 * @param {string} metadataJson - Task metadata as JSON string
 * @param {Function} [onData] - Task output stream — the FULL truss output
 *   rides the task's output column (unbounded, list-excluded, read via
 *   GET /tasks/{id}/output), never a truncated copy in the result object
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeProcessTraceTask = async (metadataJson, onData = null) => {
  log.task.debug('Process trace task starting');

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
    const { pid, duration = 30 } = metadata;

    log.task.debug('Process trace task parameters', {
      pid,
      duration,
    });

    // Use truss (OmniOS equivalent of strace) to trace the process
    const command = `pfexec truss -p ${pid}`;
    log.task.debug('Executing trace command', { command });

    // Start tracing for the specified duration
    const traceResult = await executeCommand(command, duration * 1000, onData);

    if (traceResult.success || traceResult.output) {
      // truss may exit with non-zero when the process ends, but still provide useful output
      const outputLength = traceResult.output ? traceResult.output.length : 0;
      log.task.info('Process trace completed', {
        pid,
        duration,
        output_length: outputLength,
      });

      return {
        success: true,
        message: `Process trace completed for PID ${pid} over ${duration} seconds (${outputLength} characters captured — read via GET /tasks/{id}/output)`,
        duration_seconds: duration,
        pid: parseInt(pid),
      };
    }
    log.task.error('Process trace command failed', {
      pid,
      error: traceResult.error,
    });
    return {
      success: false,
      error: `Failed to trace process ${pid}: ${traceResult.error}`,
    };
  } catch (error) {
    log.task.error('Process trace task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Process trace task failed: ${error.message}` };
  }
};
