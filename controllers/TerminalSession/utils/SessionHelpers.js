/**
 * @fileoverview Terminal Session Helpers for Zoneweaver Agent
 * @description Shared PTY process state, spawning, health checks, and cleanup for
 * terminal sessions.
 */

import os from 'os';
import pty from 'node-pty';
import { Op } from 'sequelize';
import TerminalSessions from '../../../models/TerminalSessionModel.js';
import { log, createTimer } from '../../../lib/Logger.js';

const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

// Configurable session timeout (default 30 minutes)
const SESSION_TIMEOUT_MINUTES = parseInt(process.env.TERMINAL_SESSION_TIMEOUT) || 30;

/**
 * In-memory store for active pty processes.
 * @type {Map<string, import('node-pty').IPty>}
 */
export const activePtyProcesses = new Map();

/**
 * Checks if a session is healthy by verifying the process is still running.
 * @param {string} sessionId - The UUID of the terminal session.
 * @returns {Promise<boolean>} True if session is healthy, false otherwise.
 */
export const isSessionHealthy = sessionId => {
  try {
    const ptyProcess = activePtyProcesses.get(sessionId);
    if (!ptyProcess) {
      return false;
    }

    // Check if process ID still exists
    try {
      process.kill(ptyProcess.pid, 0); // Signal 0 checks if process exists without killing
      return true;
    } catch {
      // Process doesn't exist
      activePtyProcesses.delete(sessionId);
      return false;
    }
  } catch (error) {
    log.websocket.error('Error checking terminal session health', {
      error: error.message,
      session_id: sessionId,
    });
    return false;
  }
};

/**
 * Creates a terminal session database record immediately.
 * @param {string} zoneName - The zone name for this terminal session.
 * @returns {Promise<import('../../../models/TerminalSessionModel.js').default>} The session record
 */
export const createSessionRecord = async (zoneName = null) => {
  const timer = createTimer('terminal_session_create');

  const session = await TerminalSessions.create({
    pid: 0, // Temporary PID, will be updated when PTY spawns
    zone_name: zoneName,
    status: 'connecting', // Session is being created
  });

  const duration = timer.end();
  log.websocket.debug('Terminal session record created', {
    session_id: session.id,
    zone_name: zoneName,
    duration_ms: duration,
  });

  return session;
};

/**
 * Spawns a PTY process asynchronously and updates the session record.
 * @param {import('../../../models/TerminalSessionModel.js').default} session - The session record to update
 * @returns {Promise<void>}
 */
export const spawnPtyProcessAsync = async session => {
  const timer = createTimer('pty_spawn');

  try {
    // Use simpler configuration matching the working reference
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      env: process.env,
    });

    // Update session record with actual PID and active status
    await session.update({
      pid: ptyProcess.pid,
      status: 'active',
    });

    activePtyProcesses.set(session.id, ptyProcess);

    const duration = timer.end();
    log.websocket.info('PTY process spawned successfully', {
      session_id: session.id,
      pid: ptyProcess.pid,
      duration_ms: duration,
    });

    // Use same event handler as working reference
    ptyProcess.on('exit', (code, signal) => {
      log.websocket.info('PTY process exited', {
        session_id: session.id,
        exit_code: code,
        signal,
      });
      activePtyProcesses.delete(session.id);
      session.update({ status: 'closed' });
    });
  } catch (error) {
    const duration = timer.end();
    log.websocket.error('Failed to spawn PTY process', {
      session_id: session.id,
      error: error.message,
      duration_ms: duration,
    });
    // Mark session as failed
    await session.update({ status: 'failed' });
  }
};

/**
 * Cleans up inactive terminal sessions based on configurable timeout.
 * @returns {Promise<number>} Number of sessions cleaned up.
 */
const cleanupInactiveSessions = async () => {
  const timeoutAgo = new Date(Date.now() - SESSION_TIMEOUT_MINUTES * 60 * 1000);
  const timer = createTimer('terminal_session_cleanup');

  try {
    const inactiveSessions = await TerminalSessions.findAll({
      where: {
        status: 'active',
        last_activity: { [Op.lt]: timeoutAgo },
      },
    });

    await Promise.all(
      inactiveSessions.map(async session => {
        const ptyProcess = activePtyProcesses.get(session.id);
        if (ptyProcess) {
          ptyProcess.kill();
          activePtyProcesses.delete(session.id);
        }
        await session.update({ status: 'closed' });
      })
    );

    const cleanedCount = inactiveSessions.length;

    const duration = timer.end();

    if (cleanedCount > 0) {
      log.websocket.info('Terminal cleanup completed', {
        cleaned_sessions: cleanedCount,
        timeout_minutes: SESSION_TIMEOUT_MINUTES,
        duration_ms: duration,
      });
    }

    return cleanedCount;
  } catch (error) {
    timer.end();
    log.websocket.error('Error during terminal session cleanup', {
      error: error.message,
      timeout_minutes: SESSION_TIMEOUT_MINUTES,
    });
    return 0;
  }
};

// Run cleanup every 10 minutes
setInterval(cleanupInactiveSessions, 10 * 60 * 1000);

/**
 * Retrieves an active pty process by session ID.
 * @param {string} sessionId - The UUID of the terminal session.
 * @returns {import('node-pty').IPty | undefined} The pty process or undefined if not found.
 */
export const getPtyProcess = sessionId => activePtyProcesses.get(sessionId);
