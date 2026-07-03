/**
 * @fileoverview VNC Session Manager Utilities
 * @description VNC session lifecycle management using existing process utilities
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import fs from 'fs';
import path from 'path';
import { killProcess } from '../../../lib/ProcessManager.js';
import { log } from '../../../lib/Logger.js';

/**
 * Simple VNC Session Manager using PID files (leveraging existing utilities)
 */
class VncSessionManager {
  constructor() {
    this.pidDir = './vnc_sessions';
    // Ensure PID directory exists
    if (!fs.existsSync(this.pidDir)) {
      fs.mkdirSync(this.pidDir, { recursive: true });
    }
  }

  /**
   * Get PID file path for a zone
   * @param {string} zoneName - Zone name
   * @returns {string} - PID file path
   */
  getPidFilePath(zoneName) {
    return path.join(this.pidDir, `${zoneName}.pid`);
  }

  /**
   * Check if a process is running using ProcessManager pattern
   * @param {number} pid - Process ID
   * @returns {boolean} - True if process is running
   */
  isProcessRunning(pid) {
    try {
      // Use Node.js built-in process.kill with signal 0 (like TerminalSessionController)
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get session info from PID file with process validation
   * @param {string} zoneName - Zone name
   * @returns {Object|null} - Session info or null if not found/invalid
   */
  getSessionInfo(zoneName) {
    const pidFile = this.getPidFilePath(zoneName);

    if (!fs.existsSync(pidFile)) {
      return null;
    }

    try {
      const lines = fs.readFileSync(pidFile, 'utf8').trim().split('\n');
      if (lines.length < 5) {
        // Invalid PID file, clean it up
        fs.unlinkSync(pidFile);
        return null;
      }

      const [pid, command, timestamp, vmname, netport] = lines;
      const pidNum = parseInt(pid);

      // Check if process is actually running using ProcessManager pattern
      const isRunning = this.isProcessRunning(pidNum);
      if (!isRunning) {
        log.websocket.debug('PID file exists but process is dead, cleaning up', {
          pid: pidNum,
          zone_name: zoneName,
        });
        fs.unlinkSync(pidFile);
        return null;
      }

      return {
        pid: pidNum,
        command,
        timestamp,
        vmname,
        netport,
        port: parseInt(netport.split(':')[1]),
      };
    } catch {
      log.websocket.warn('Error reading PID file', {
        zone_name: zoneName,
      });
      // Clean up corrupted PID file
      try {
        fs.unlinkSync(pidFile);
      } catch {
        // Ignore cleanup errors
      }
      return null;
    }
  }

  /**
   * Write session info to PID file
   * @param {string} zoneName - Zone name
   * @param {number} pid - Process ID
   * @param {string} command - Command used
   * @param {string} netport - Network port (ip:port)
   */
  writeSessionInfo(zoneName, pid, command, netport) {
    const pidFile = this.getPidFilePath(zoneName);
    const timestamp = new Date().toISOString();
    const content = `${pid}\n${command}\n${timestamp}\n${zoneName}\n${netport}`;

    fs.writeFileSync(pidFile, content);
    log.websocket.debug('Session info written to PID file', {
      pid_file: pidFile,
      zone_name: zoneName,
      pid,
    });
  }

  /**
   * Kill session and clean up PID file using ProcessManager
   * @param {string} zoneName - Zone name
   * @returns {Promise<boolean>} - True if session was killed
   */
  async killSession(zoneName) {
    const sessionInfo = this.getSessionInfo(zoneName);

    if (!sessionInfo) {
      log.websocket.debug('No active session found', { zone_name: zoneName });
      return false;
    }

    try {
      log.websocket.info('Killing VNC session using ProcessManager', {
        zone_name: zoneName,
        pid: sessionInfo.pid,
      });

      // Use ProcessManager.killProcess instead of custom pfexec logic
      const result = await killProcess(sessionInfo.pid, true); // force=true for immediate SIGKILL

      if (result.success) {
        log.websocket.info('Successfully killed VNC session', {
          zone_name: zoneName,
          pid: sessionInfo.pid,
          message: result.message,
        });

        // Remove PID file
        const pidFile = this.getPidFilePath(zoneName);
        if (fs.existsSync(pidFile)) {
          fs.unlinkSync(pidFile);
          log.websocket.debug('Removed PID file', { zone_name: zoneName });
        }

        return true;
      }

      log.websocket.error('Failed to kill VNC session', {
        zone_name: zoneName,
        pid: sessionInfo.pid,
        error: result.error,
      });
      return false;
    } catch {
      log.websocket.error('Error killing session', {
        zone_name: zoneName,
      });
      return false;
    }
  }

  /**
   * Check if zone has an active session
   * @param {string} zoneName - Zone name
   * @returns {boolean} - True if session is active
   */
  hasActiveSession(zoneName) {
    const sessionInfo = this.getSessionInfo(zoneName);
    return sessionInfo !== null;
  }

  /**
   * Clean up all stale PID files on startup using Promise.all() for performance
   */
  async cleanupStaleSessions() {
    if (!fs.existsSync(this.pidDir)) {
      return;
    }

    const pidFiles = fs.readdirSync(this.pidDir).filter(file => file.endsWith('.pid'));

    // Use synchronous processing since getSessionInfo is now synchronous
    const cleanupPromises = pidFiles.map(pidFile => {
      const zoneName = pidFile.replace('.pid', '');
      const sessionInfo = this.getSessionInfo(zoneName);

      if (!sessionInfo) {
        log.websocket.info('Cleaned up stale PID file', { zone_name: zoneName });
        return { cleaned: true, zone_name: zoneName };
      }
      return { cleaned: false, zone_name: zoneName };
    });

    const results = await Promise.all(cleanupPromises);
    const cleanedCount = results.filter(result => result.cleaned).length;

    log.websocket.info('VNC startup cleanup completed', {
      cleaned_count: cleanedCount,
    });
  }
}

/**
 * Create and export singleton session manager
 */
export const sessionManager = new VncSessionManager();
