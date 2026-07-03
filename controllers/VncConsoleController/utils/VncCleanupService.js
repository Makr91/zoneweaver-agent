/**
 * @fileoverview VNC Cleanup Service Utilities
 * @description VNC session cleanup operations using existing process utilities with parallel execution
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import fs from 'fs';
import { Op } from 'sequelize';
import VncSessions from '../../../models/VncSessionModel.js';
import { getZoneConfig } from '../../../lib/ZoneConfigUtils.js';
import { testVncConnection } from './VncValidation.js';
import { sessionManager } from './VncSessionManager.js';
import { log } from '../../../lib/Logger.js';
import config from '../../../config/ConfigLoader.js';

/**
 * Check if zone has VNC enabled at boot (from zadm configuration)
 * @param {string} zoneName - Zone name
 * @returns {Promise<boolean>} - True if VNC is enabled at boot
 */
export const isVncEnabledAtBoot = async zoneName => {
  try {
    log.websocket.debug('Checking VNC boot configuration for zone', { zone_name: zoneName });

    // Get zone configuration using shared utility
    const zoneConfig = await getZoneConfig(zoneName);

    // Check if VNC is enabled: zoneConfig.vnc.enabled === "on"
    const vncEnabled = zoneConfig.vnc && zoneConfig.vnc.enabled === 'on';

    log.websocket.debug('Zone VNC boot setting', {
      zone_name: zoneName,
      vnc_enabled: vncEnabled,
    });
    return vncEnabled;
  } catch {
    log.websocket.warn('Error checking VNC boot configuration', {
      zone_name: zoneName,
    });
    return false; // Default to false if we can't determine
  }
};

/**
 * Clean up stale VNC sessions using Promise.all() for parallel execution
 * @returns {Promise<number>} Number of sessions cleaned up
 */
export const cleanupVncSessions = async () => {
  try {
    const vncConfig = config.getVnc();
    const sessionTimeout = (vncConfig.session_timeout || 1800) * 1000; // Convert seconds to milliseconds
    const cutoffTime = new Date(Date.now() - sessionTimeout);
    let cleanedCount = 0;

    // Clean up old active sessions in database
    const staleSessions = await VncSessions.findAll({
      where: {
        status: 'active',
        last_accessed: {
          [Op.lt]: cutoffTime,
        },
      },
    });

    // Use Promise.all() for parallel session cleanup (performance optimization)
    const cleanupPromises = staleSessions.map(async session => {
      try {
        // Kill session using session manager
        await sessionManager.killSession(session.zone_name);

        // Update session status
        await session.update({ status: 'stopped' });
        log.websocket.info('Cleaned up stale VNC session', {
          zone_name: session.zone_name,
        });
        return { success: true, zone_name: session.zone_name };
      } catch {
        log.websocket.error('Error cleaning up VNC session', {
          session_id: session.id,
        });
        return { success: false, zone_name: session.zone_name };
      }
    });

    const cleanupResults = await Promise.all(cleanupPromises);
    cleanedCount = cleanupResults.filter(result => result.success).length;

    // Delete all stopped sessions since they can't be reopened
    const stoppedSessions = await VncSessions.findAll({
      where: { status: 'stopped' },
    });

    // Use Promise.all() for parallel session deletion (performance optimization)
    const deletionPromises = stoppedSessions.map(async session => {
      try {
        await session.destroy();
        log.websocket.debug('Deleted stopped VNC session', {
          zone_name: session.zone_name,
        });
        return { success: true };
      } catch {
        log.websocket.error('Error deleting stopped VNC session', {
          session_id: session.id,
        });
        return { success: false };
      }
    });

    const deletionResults = await Promise.all(deletionPromises);
    cleanedCount += deletionResults.filter(result => result.success).length;

    return cleanedCount;
  } catch {
    log.websocket.error('Error during VNC session cleanup');
    return 0;
  }
};

/**
 * Clean up orphaned VNC processes that we manage (conservative approach)
 * @returns {Promise<number>} Number of orphaned processes killed
 */
export const cleanupOrphanedVncProcesses = async () => {
  try {
    log.websocket.debug('Scanning for orphaned managed VNC processes');

    let killedCount = 0;

    // Method 1: Clean up VNC processes tracked in database
    const dbSessions = await VncSessions.findAll({
      where: { status: 'active' },
    });

    const dbCleanupPromises = dbSessions.map(async session => {
      try {
        // Check if this database-tracked process is still alive
        const isAlive = sessionManager.isProcessRunning(session.process_id);
        if (!isAlive) {
          // Process is dead but database thinks it's active - clean up
          await session.update({ status: 'stopped' });
          log.websocket.debug('Cleaned up dead database VNC session', {
            zone_name: session.zone_name,
            pid: session.process_id,
          });
          return { cleaned: true, zone_name: session.zone_name };
        }
        return { cleaned: false, zone_name: session.zone_name };
      } catch {
        // Error checking process - assume it's dead and clean up
        await session.update({ status: 'stopped' });
        return { cleaned: true, zone_name: session.zone_name };
      }
    });

    const dbResults = await Promise.all(dbCleanupPromises);
    killedCount += dbResults.filter(result => result.cleaned).length;

    // Method 2: Clean up VNC processes tracked by PID files
    if (sessionManager.pidDir && fs.existsSync(sessionManager.pidDir)) {
      const pidFiles = fs.readdirSync(sessionManager.pidDir).filter(file => file.endsWith('.pid'));

      const pidCleanupPromises = pidFiles.map(pidFile => {
        const zoneName = pidFile.replace('.pid', '');
        const sessionInfo = sessionManager.getSessionInfo(zoneName);

        if (sessionInfo) {
          // PID file exists and process is alive - keep it
          return { cleaned: false, zone_name: zoneName };
        }
        // PID file exists but process is dead - already cleaned by getSessionInfo()
        log.websocket.debug('Cleaned up stale PID file', { zone_name: zoneName });
        return { cleaned: true, zone_name: zoneName };
      });

      const pidResults = await Promise.all(pidCleanupPromises);
      killedCount += pidResults.filter(result => result.cleaned).length;
    }

    if (killedCount > 0) {
      log.websocket.info('Cleaned up orphaned managed VNC sessions', {
        cleaned_count: killedCount,
      });
    } else {
      log.websocket.debug('No orphaned managed VNC sessions found');
    }

    return killedCount;
  } catch (error) {
    log.websocket.error('Error cleaning up orphaned VNC processes', {
      error: error.message,
    });
    return 0;
  }
};

/**
 * Clean up stale sessions on startup using Promise.all() for parallel execution
 * @returns {Promise<number>} Total number of items cleaned up
 */
export const cleanupStaleSessionsOnStartup = async () => {
  try {
    log.websocket.info('Cleaning up stale VNC sessions from previous backend instance');

    // Step 1: Clean up orphaned VNC processes first
    const orphanedCount = await cleanupOrphanedVncProcesses();

    // Step 2: Clean up PID files from previous instance
    await sessionManager.cleanupStaleSessions();

    // Step 3: Update database to mark orphaned sessions as stopped using Promise.all()
    const activeSessions = await VncSessions.findAll({
      where: { status: 'active' },
    });

    // Use Promise.all() for parallel session testing and cleanup (performance optimization)
    const sessionPromises = activeSessions.map(async session => {
      try {
        // Test if the VNC port is actually responding
        const isPortResponding = await testVncConnection(session.web_port, 4);

        if (!isPortResponding) {
          // Port not responding, mark session as stopped
          await session.update({ status: 'stopped' });
          log.websocket.info('Cleaned up stale VNC session', {
            zone_name: session.zone_name,
            port: session.web_port,
          });
          return { cleaned: true, zone_name: session.zone_name };
        }

        log.websocket.debug('VNC session is still active', {
          zone_name: session.zone_name,
          port: session.web_port,
        });
        return { cleaned: false, zone_name: session.zone_name };
      } catch {
        // If we can't test the connection, assume it's stale and clean it up
        await session.update({ status: 'stopped' });
        log.websocket.info('Cleaned up stale VNC session (error testing port)', {
          zone_name: session.zone_name,
        });
        return { cleaned: true, zone_name: session.zone_name };
      }
    });

    const sessionResults = await Promise.all(sessionPromises);
    const cleanedCount = sessionResults.filter(result => result.cleaned).length;

    log.websocket.info('Startup cleanup completed', {
      stale_sessions_cleaned: cleanedCount,
      orphaned_processes_killed: orphanedCount,
    });
    return cleanedCount + orphanedCount;
  } catch {
    log.websocket.error('Error during startup VNC session cleanup');
    return 0;
  }
};

/**
 * Start VNC session cleanup interval (similar to TerminalSession pattern)
 */
export const startVncSessionCleanup = () => {
  // Clean up stale sessions from previous backend instance on startup
  cleanupStaleSessionsOnStartup();

  // Get cleanup interval from configuration
  const vncConfig = config.getVnc();
  const cleanupInterval = (vncConfig.cleanup_interval || 300) * 1000; // Convert seconds to milliseconds

  // Clean up stale sessions at configured interval
  setInterval(cleanupVncSessions, cleanupInterval);
  log.websocket.info('VNC session cleanup started', {
    cleanup_interval_seconds: cleanupInterval / 1000,
  });
};
