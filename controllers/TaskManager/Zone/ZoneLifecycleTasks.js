/**
 * @fileoverview Zone Lifecycle Task Executors for Zoneweaver Agent
 * @description Executes zone start, stop, restart operations and VNC session termination.
 */
import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import Zones from '../../../models/ZoneModel.js';
import VncSessions from '../../../models/VncSessionModel.js';

/**
 * Zone Manager for Zone Lifecycle Operations
 * Handles zone start, stop, restart, delete, discover operations and VNC session termination
 */

/**
 * Terminate VNC session for a zone
 * @param {string} zoneName - Name of zone
 */
export const terminateVncSession = async zoneName => {
  try {
    const session = await VncSessions.findOne({
      where: { zone_name: zoneName, status: 'active' },
    });

    if (session && session.process_id) {
      try {
        process.kill(session.process_id, 'SIGTERM');
      } catch (error) {
        log.task.warn('Failed to kill VNC process', {
          zone_name: zoneName,
          process_id: session.process_id,
          error: error.message,
        });
      }

      await session.update({ status: 'stopped' });
    }
  } catch (error) {
    log.task.warn('Failed to terminate VNC session', {
      zone_name: zoneName,
      error: error.message,
    });
  }
};

/**
 * Execute zone start task
 * @param {string} zoneName - Name of zone to start
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeStartTask = async zoneName => {
  const result = await executeCommand(`pfexec zoneadm -z ${zoneName} boot`);

  if (result.success) {
    // Fix zonepath permissions after boot (zoneadm resets to 700)
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (zone) {
      let zoneConfig = zone.configuration;
      if (typeof zoneConfig === 'string') {
        try {
          zoneConfig = JSON.parse(zoneConfig);
        } catch (e) {
          log.task.warn('Failed to parse zone configuration', { error: e.message });
        }
      }
      const zonepath = zoneConfig?.zonepath;
      if (zonepath) {
        const chmodResult = await executeCommand(`pfexec chmod 755 ${zonepath}`);
        if (!chmodResult.success) {
          log.task.warn('Failed to set zonepath permissions after boot', {
            zonepath,
            error: chmodResult.error,
          });
        }
      }
    }

    // Update zone status in database
    await Zones.update(
      {
        status: 'running',
        last_seen: new Date(),
        is_orphaned: false,
      },
      { where: { name: zoneName } }
    );

    return {
      success: true,
      message: `Zone ${zoneName} started successfully`,
    };
  }
  return {
    success: false,
    error: `Failed to start zone ${zoneName}: ${result.error}`,
  };
};

/**
 * Execute zone stop task
 * @param {string} zoneName - Name of zone to stop
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeStopTask = async zoneName => {
  // First try graceful shutdown
  let result = await executeCommand(`pfexec zoneadm -z ${zoneName} shutdown`);

  // If graceful shutdown fails, try halt
  if (!result.success) {
    result = await executeCommand(`pfexec zoneadm -z ${zoneName} halt`);
  }

  if (result.success) {
    // Update zone status in database
    await Zones.update(
      {
        status: 'installed',
        last_seen: new Date(),
      },
      { where: { name: zoneName } }
    );

    // Terminate any active VNC sessions for this zone
    await terminateVncSession(zoneName);

    return {
      success: true,
      message: `Zone ${zoneName} stopped successfully`,
    };
  }
  return {
    success: false,
    error: `Failed to stop zone ${zoneName}: ${result.error}`,
  };
};

/**
 * Execute zone restart task
 * @param {string} zoneName - Name of zone to restart
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRestartTask = async zoneName => {
  // Stop first
  const stopResult = await executeStopTask(zoneName);
  if (!stopResult.success) {
    return stopResult;
  }

  // Wait a moment for clean shutdown
  await new Promise(resolve => {
    setTimeout(resolve, 2000);
  });

  // Then start
  return executeStartTask(zoneName);
};
