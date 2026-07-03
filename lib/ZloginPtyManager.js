/**
 * @fileoverview Zlogin PTY Manager for Zoneweaver Agent
 * @description Central manager for shared zlogin console PTY processes.
 *              Maintains one PTY per zone, multiplexed between automation and WebSocket clients.
 *              Strips ANSI codes for reliable pattern matching in automation recipes.
 */

import pty from 'node-pty';
import { log } from './Logger.js';
import ZloginSessions from '../models/ZloginSessionModel.js';

/**
 * ANSI escape sequence regex for terminal color codes and control sequences
 * Strips: colors, cursor movement, formatting, etc.
 * Constructing regex dynamically to avoid control character linting error
 */
const createAnsiRegex = () => {
  const esc = String.fromCharCode(27);
  const csi = String.fromCharCode(155);
  return new RegExp(
    `[${esc}${csi}][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]`,
    'g'
  );
};
const ANSI_REGEX = createAnsiRegex();

/**
 * Strip ANSI escape sequences from string
 * @param {string} str - String with ANSI codes
 * @returns {string} Clean string
 */
const stripAnsi = str => str.replace(ANSI_REGEX, '');

/**
 * Internal session structure
 * @typedef {Object} ZloginPtySession
 * @property {import('node-pty').IPty} ptyProcess - The PTY process
 * @property {string} rawBuffer - Raw output with ANSI codes (for WebSocket display)
 * @property {string} strippedBuffer - ANSI-stripped output (for pattern matching)
 * @property {Set<Function>} subscribers - Output callbacks (WebSocket data handlers)
 * @property {boolean} automationActive - Whether automation is currently running
 * @property {number} pid - Process ID
 * @property {Date} createdAt - Creation timestamp
 * @property {Date} lastActivity - Last activity timestamp
 */

/**
 * Centralized PTY manager for zlogin sessions
 * Ensures one PTY per zone, shared between automation and frontend
 */
class ZloginPtyManager {
  constructor() {
    /** @type {Map<string, ZloginPtySession>} */
    this.sessions = new Map();

    // Cleanup idle sessions every 5 minutes
    setInterval(() => this._cleanupIdleSessions(), 5 * 60 * 1000);
  }

  /**
   * Get or create a shared PTY session for a zone
   * @param {string} zoneName - Zone name
   * @param {Object} [options] - PTY options
   * @param {number} [options.cols=80] - Terminal columns
   * @param {number} [options.rows=30] - Terminal rows
   * @returns {ZloginPtySession} Session object
   */
  getOrCreate(zoneName, options = {}) {
    // Return existing session if alive
    if (this.sessions.has(zoneName)) {
      const session = this.sessions.get(zoneName);
      if (this._isProcessAlive(session.ptyProcess)) {
        log.websocket.debug('Reusing existing zlogin PTY', {
          zone_name: zoneName,
          pid: session.pid,
        });
        session.lastActivity = new Date();
        return session;
      }

      // Session exists but PTY is dead - clean it up
      log.websocket.warn('Existing PTY is dead, creating new one', {
        zone_name: zoneName,
        old_pid: session.pid,
      });
      this.sessions.delete(zoneName);
    }

    // Create new PTY session
    const cols = options.cols || 80;
    const rows = options.rows || 30;

    log.websocket.info('Spawning new zlogin PTY', {
      zone_name: zoneName,
      cols,
      rows,
    });

    const ptyProcess = pty.spawn('bash', ['-c', `pfexec zlogin -C ${zoneName}`], {
      name: 'xterm-color',
      cols,
      rows,
      env: process.env,
    });

    const session = {
      ptyProcess,
      rawBuffer: '',
      strippedBuffer: '',
      subscribers: new Set(),
      automationActive: false,
      pid: ptyProcess.pid,
      createdAt: new Date(),
      lastActivity: new Date(),
    };

    this.sessions.set(zoneName, session);

    // Set up PTY event handlers
    ptyProcess.on('data', data => {
      session.rawBuffer += data;
      session.strippedBuffer += stripAnsi(data);
      session.lastActivity = new Date();

      // Limit buffer sizes (keep last 100KB)
      if (session.rawBuffer.length > 100000) {
        session.rawBuffer = session.rawBuffer.slice(-100000);
      }
      if (session.strippedBuffer.length > 100000) {
        session.strippedBuffer = session.strippedBuffer.slice(-100000);
      }

      // Notify all subscribers
      session.subscribers.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          log.websocket.error('Error in subscriber callback', {
            zone_name: zoneName,
            error: error.message,
          });
        }
      });
    });

    ptyProcess.on('exit', (code, signal) => {
      log.websocket.info('Zlogin PTY exited', {
        zone_name: zoneName,
        pid: session.pid,
        exit_code: code,
        signal,
      });
      this.sessions.delete(zoneName);

      // Update DB sessions for this zone
      ZloginSessions.update({ status: 'closed' }, { where: { zone_name: zoneName } }).catch(err => {
        log.websocket.error('Failed to update DB sessions after PTY exit', {
          zone_name: zoneName,
          error: err.message,
        });
      });
    });

    ptyProcess.on('error', error => {
      log.websocket.error('Zlogin PTY error', {
        zone_name: zoneName,
        pid: session.pid,
        error: error.message,
      });
    });

    log.websocket.info('Zlogin PTY session created', {
      zone_name: zoneName,
      pid: session.pid,
      subscribers: 0,
    });

    return session;
  }

  /**
   * Subscribe to PTY output
   * @param {string} zoneName - Zone name
   * @param {Function} callback - Called with (data: string) for each PTY output
   * @returns {Function} Unsubscribe function
   */
  subscribe(zoneName, callback) {
    const session = this.sessions.get(zoneName);
    if (!session) {
      throw new Error(`No PTY session for zone '${zoneName}'`);
    }

    session.subscribers.add(callback);
    session.lastActivity = new Date();

    log.websocket.debug('Subscriber added to zlogin PTY', {
      zone_name: zoneName,
      subscriber_count: session.subscribers.size,
    });

    // Return unsubscribe function
    return () => {
      session.subscribers.delete(callback);
      log.websocket.debug('Subscriber removed from zlogin PTY', {
        zone_name: zoneName,
        subscriber_count: session.subscribers.size,
      });
    };
  }

  /**
   * Write data to zone's PTY
   * @param {string} zoneName - Zone name
   * @param {string} data - Data to write
   */
  write(zoneName, data) {
    const session = this.sessions.get(zoneName);
    if (!session) {
      throw new Error(`No PTY session for zone '${zoneName}'`);
    }

    if (!this._isProcessAlive(session.ptyProcess)) {
      throw new Error(`PTY process for zone '${zoneName}' is not alive`);
    }

    session.ptyProcess.write(data);
    session.lastActivity = new Date();
  }

  /**
   * Wait for a pattern in the ANSI-stripped output buffer
   * @param {string} zoneName - Zone name
   * @param {string} pattern - Literal string to match (or regex string if useRegex=true)
   * @param {number} timeout - Timeout in milliseconds
   * @param {number} [globalDeadline] - Absolute deadline timestamp
   * @param {Object} [options] - Options
   * @param {boolean} [options.useRegex=false] - Treat pattern as regex (don't escape)
   * @returns {Promise<{matched: boolean, match?: string}>}
   */
  waitForPattern(zoneName, pattern, timeout, globalDeadline, options = {}) {
    const session = this.sessions.get(zoneName);
    if (!session) {
      return Promise.resolve({ matched: false });
    }

    return new Promise(resolve => {
      const deadline = globalDeadline
        ? Math.min(Date.now() + timeout, globalDeadline)
        : Date.now() + timeout;

      // Use raw regex or escape for literal matching
      const regex = options.useRegex
        ? new RegExp(pattern)
        : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

      // Check if already in stripped buffer
      if (regex.test(session.strippedBuffer)) {
        resolve({ matched: true, match: pattern });
        return;
      }

      const interval = setInterval(() => {
        if (!this.sessions.has(zoneName) || !this._isProcessAlive(session.ptyProcess)) {
          clearInterval(interval);
          resolve({ matched: false });
          return;
        }

        if (regex.test(session.strippedBuffer)) {
          clearInterval(interval);
          resolve({ matched: true, match: pattern });
          return;
        }

        if (Date.now() >= deadline) {
          clearInterval(interval);
          resolve({ matched: false });
        }
      }, 250);
    });
  }

  /**
   * Clear the output buffers (both raw and stripped)
   * Used before sending a command to capture only its output
   * @param {string} zoneName - Zone name
   */
  clearBuffer(zoneName) {
    const session = this.sessions.get(zoneName);
    if (session) {
      session.rawBuffer = '';
      session.strippedBuffer = '';
    }
  }

  /**
   * Get raw output buffer (with ANSI codes)
   * @param {string} zoneName - Zone name
   * @returns {string} Raw buffer
   */
  getRawBuffer(zoneName) {
    const session = this.sessions.get(zoneName);
    return session ? session.rawBuffer : '';
  }

  /**
   * Get ANSI-stripped output buffer
   * @param {string} zoneName - Zone name
   * @returns {string} Stripped buffer
   */
  getStrippedBuffer(zoneName) {
    const session = this.sessions.get(zoneName);
    return session ? session.strippedBuffer : '';
  }

  /**
   * Mark automation as active/inactive
   * @param {string} zoneName - Zone name
   * @param {boolean} active - Automation state
   */
  async setAutomationActive(zoneName, active) {
    const session = this.sessions.get(zoneName);
    if (session) {
      session.automationActive = active;
      session.lastActivity = new Date();

      log.task.info('Automation state changed', {
        zone_name: zoneName,
        automation_active: active,
      });

      // Update DB session record
      try {
        await ZloginSessions.update(
          { automation_active: active },
          { where: { zone_name: zoneName, status: 'active' } }
        );
      } catch (error) {
        log.websocket.error('Failed to update automation_active in DB', {
          zone_name: zoneName,
          error: error.message,
        });
      }
    }
  }

  /**
   * Check if automation is active for a zone
   * @param {string} zoneName - Zone name
   * @returns {boolean} Automation state
   */
  isAutomationActive(zoneName) {
    const session = this.sessions.get(zoneName);
    return session ? session.automationActive : false;
  }

  /**
   * Get subscriber count
   * @param {string} zoneName - Zone name
   * @returns {number} Number of active subscribers
   */
  getSubscriberCount(zoneName) {
    const session = this.sessions.get(zoneName);
    return session ? session.subscribers.size : 0;
  }

  /**
   * Check if session exists and PTY is alive
   * @param {string} zoneName - Zone name
   * @returns {boolean} True if session exists and is healthy
   */
  isAlive(zoneName) {
    const session = this.sessions.get(zoneName);
    return session ? this._isProcessAlive(session.ptyProcess) : false;
  }

  /**
   * Get session info
   * @param {string} zoneName - Zone name
   * @returns {Object|null} Session metadata
   */
  getSessionInfo(zoneName) {
    const session = this.sessions.get(zoneName);
    if (!session) {
      return null;
    }

    return {
      zone_name: zoneName,
      pid: session.pid,
      created_at: session.createdAt,
      last_activity: session.lastActivity,
      automation_active: session.automationActive,
      subscriber_count: session.subscribers.size,
      buffer_size_raw: session.rawBuffer.length,
      buffer_size_stripped: session.strippedBuffer.length,
    };
  }

  /**
   * Destroy a zone's PTY session
   * Sends ~.\r\n escape sequence to detach, then kills process
   * @param {string} zoneName - Zone name
   */
  async destroy(zoneName) {
    const session = this.sessions.get(zoneName);
    if (!session) {
      log.websocket.debug('No PTY session to destroy', { zone_name: zoneName });
      return;
    }

    log.websocket.info('Destroying zlogin PTY', {
      zone_name: zoneName,
      pid: session.pid,
      automation_active: session.automationActive,
      subscribers: session.subscribers.size,
    });

    try {
      // Send escape sequence to detach from zlogin console
      if (this._isProcessAlive(session.ptyProcess)) {
        session.ptyProcess.write('~.\r\n');
      }

      // Give it a moment to detach, then kill
      setTimeout(() => {
        try {
          if (this._isProcessAlive(session.ptyProcess)) {
            session.ptyProcess.kill();
          }
        } catch (error) {
          log.websocket.warn('Error killing PTY process', {
            zone_name: zoneName,
            error: error.message,
          });
        }
      }, 1000);
    } catch (error) {
      log.websocket.error('Error during PTY destroy', {
        zone_name: zoneName,
        error: error.message,
      });
    }

    this.sessions.delete(zoneName);

    // Update DB sessions
    try {
      await ZloginSessions.update({ status: 'closed' }, { where: { zone_name: zoneName } });
    } catch (error) {
      log.websocket.error('Failed to update DB sessions after destroy', {
        zone_name: zoneName,
        error: error.message,
      });
    }
  }

  /**
   * Destroy all sessions (for server shutdown)
   */
  async destroyAll() {
    log.websocket.info('Destroying all zlogin PTY sessions', {
      count: this.sessions.size,
    });

    const destroyPromises = Array.from(this.sessions.keys()).map(zoneName =>
      this.destroy(zoneName)
    );
    await Promise.all(destroyPromises);
  }

  /**
   * Check if a PTY process is alive
   * @param {import('node-pty').IPty} ptyProcess - PTY process
   * @returns {boolean} True if alive
   * @private
   */
  _isProcessAlive(ptyProcess) {
    if (!ptyProcess || !ptyProcess.pid || ptyProcess.killed) {
      return false;
    }

    try {
      process.kill(ptyProcess.pid, 0); // Signal 0 checks existence
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean up idle sessions (no subscribers, no automation, idle > 10 minutes)
   * @private
   */
  async _cleanupIdleSessions() {
    const now = Date.now();
    const idleTimeout = 10 * 60 * 1000; // 10 minutes

    const sessionsToCleanup = [];

    for (const [zoneName, session] of this.sessions.entries()) {
      const idleTime = now - session.lastActivity.getTime();

      if (session.subscribers.size === 0 && !session.automationActive && idleTime > idleTimeout) {
        sessionsToCleanup.push(zoneName);
      }
    }

    // Clean up in parallel to avoid await-in-loop
    await Promise.all(
      sessionsToCleanup.map(async zoneName => {
        const session = this.sessions.get(zoneName);
        if (session) {
          log.websocket.info('Cleaning up idle zlogin PTY', {
            zone_name: zoneName,
            idle_minutes: Math.round((now - session.lastActivity.getTime()) / 60000),
          });
          await this.destroy(zoneName);
        }
      })
    );
  }
}

// Singleton instance
export const ptyManager = new ZloginPtyManager();
export { stripAnsi };
