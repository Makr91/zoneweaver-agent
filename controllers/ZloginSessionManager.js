import ZloginSessions from '../models/ZloginSessionModel.js';
import fs from 'fs';
import { spawn } from 'child_process';
import { log } from '../lib/Logger.js';

class ZloginSessionManager {
  constructor() {
    this.pidDir = './zlogin_sessions';
    if (!fs.existsSync(this.pidDir)) {
      fs.mkdirSync(this.pidDir, { recursive: true });
    }
  }

  /**
   * Check for running zlogin processes for a specific zone
   * @param {string} zoneName - The zone name to check
   * @returns {Promise<number|null>} The PID if found, null otherwise
   */
  findRunningZloginProcess(zoneName) {
    try {
      const psProcess = spawn('ps', ['auxww'], { stdio: ['ignore', 'pipe', 'pipe'] });

      return new Promise(resolve => {
        let output = '';

        psProcess.stdout.on('data', data => {
          output += data.toString();
        });

        psProcess.on('exit', () => {
          const lines = output.split('\n');

          for (const line of lines) {
            if (line.includes('zlogin -C') && line.includes(zoneName)) {
              const parts = line.trim().split(/\s+/);
              if (parts.length >= 2) {
                const pid = parseInt(parts[1]);
                if (!isNaN(pid)) {
                  log.websocket.debug('Found running zlogin process', {
                    zone_name: zoneName,
                    pid,
                  });
                  resolve(pid);
                  return;
                }
              }
            }
          }
          resolve(null);
        });

        psProcess.on('error', () => {
          resolve(null);
        });
      });
    } catch (error) {
      log.websocket.error('Error checking for running zlogin processes', {
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Kill a specific zlogin process by PID
   * @param {number} pid - The process ID to kill
   * @returns {Promise<boolean>} True if successfully killed
   */
  killZloginProcess(pid) {
    try {
      log.websocket.info('Killing zlogin process', { pid });
      const killProcess = spawn('pfexec', ['kill', '-9', pid.toString()], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      return new Promise(resolve => {
        killProcess.on('exit', code => {
          if (code === 0) {
            log.websocket.info('Successfully killed zlogin process', { pid });
            resolve(true);
          } else {
            log.websocket.error('Failed to kill zlogin process', {
              pid,
              exit_code: code,
            });
            resolve(false);
          }
        });

        killProcess.on('error', error => {
          log.websocket.error('Error killing zlogin process', {
            pid,
            error: error.message,
          });
          resolve(false);
        });
      });
    } catch (error) {
      log.websocket.error('Error killing zlogin process', {
        pid,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Clean up stale zlogin processes for a specific zone
   * @param {string} zoneName - The zone name to clean up
   * @returns {Promise<boolean>} True if cleanup was successful
   */
  async cleanupStaleZloginProcesses(zoneName) {
    try {
      log.websocket.debug('Cleaning up stale zlogin processes', {
        zone_name: zoneName,
      });

      const runningPid = await this.findRunningZloginProcess(zoneName);

      if (runningPid) {
        await this.killZloginProcess(runningPid);

        const staleSessions = await ZloginSessions.findAll({
          where: {
            zone_name: zoneName,
          },
        });

        await Promise.all(
          staleSessions.map(session => {
            log.websocket.debug('Cleaning up stale database session', {
              session_id: session.id,
            });
            return session.destroy();
          })
        );

        log.websocket.info('Cleanup completed', {
          zone_name: zoneName,
        });
        return true;
      }
      log.websocket.debug('No stale zlogin processes found', {
        zone_name: zoneName,
      });
      return true;
    } catch (error) {
      log.websocket.error('Error during cleanup', {
        zone_name: zoneName,
        error: error.message,
      });
      return false;
    }
  }

  async cleanupStaleSessions() {
    const activeSessions = await ZloginSessions.findAll({
      where: {
        status: ['active', 'connecting'],
      },
    });

    const results = await Promise.all(
      activeSessions.map(async session => {
        try {
          if (session.pid !== null) {
            process.kill(session.pid, 0);
          }
          return 0;
        } catch {
          await session.update({ status: 'closed' });
          return 1;
        }
      })
    );
    const cleanedCount = results.reduce((a, b) => a + b, 0);
    log.websocket.info('Zlogin startup cleanup completed', {
      cleaned_count: cleanedCount,
    });
  }
}

export const sessionManager = new ZloginSessionManager();
