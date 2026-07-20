import { Client } from 'ssh2';
import { isTaskCancelled } from './TaskContext.js';
import { log } from './Logger.js';

/**
 * Poll SSH availability with exponential backoff (intentionally sequential polling)
 * @param {Object} connOptions - ssh2 connection options
 * @param {number} startTime
 * @param {number} deadline
 * @param {number} interval
 * @returns {Promise<{success: boolean, elapsed_ms: number}>}
 */
export const pollSSH = (connOptions, startTime, deadline, interval) => {
  const check = async () => {
    if (isTaskCancelled()) {
      return { success: false, cancelled: true, elapsed_ms: Date.now() - startTime };
    }
    if (Date.now() >= deadline) {
      const elapsed = Date.now() - startTime;
      return { success: false, elapsed_ms: elapsed };
    }

    const result = await new Promise(resolve => {
      const conn = new Client();
      let resolved = false;

      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          conn.end();
        }
      };

      const timeout = setTimeout(() => {
        cleanup();
        resolve({ success: false });
      }, 10000);

      conn
        .on('ready', () => {
          clearTimeout(timeout);
          conn.exec('echo ready', (err, stream) => {
            if (err) {
              cleanup();
              resolve({ success: false });
              return;
            }

            let output = '';
            stream
              .on('close', () => {
                cleanup();
                resolve({ success: output.includes('ready'), output });
              })
              .on('data', data => {
                output += data.toString();
              })
              .stderr.on('data', data => {
                void data;
              });
          });
        })
        .on('error', err => {
          clearTimeout(timeout);
          cleanup();
          log.task.debug('SSH connection error during poll', { error: err.message });
          resolve({ success: false });
        })
        .connect(connOptions);
    });

    if (result.success) {
      const elapsed = Date.now() - startTime;
      log.task.info('SSH is available', {
        ip: connOptions.host,
        port: connOptions.port,
        elapsed_ms: elapsed,
      });
      return { success: true, elapsed_ms: elapsed };
    }

    await new Promise(resolve => {
      setTimeout(resolve, interval);
    });
    return check();
  };

  return check();
};
