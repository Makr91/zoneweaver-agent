/**
 * @fileoverview Zone Lifecycle Task Executors for Zoneweaver Agent
 * @description Executes zone start, stop, restart, suspend, resume operations
 * and VNC session termination.
 */
import config from '../../../config/ConfigLoader.js';
import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import Zones from '../../../models/ZoneModel.js';
import VncSessions from '../../../models/VncSessionModel.js';
import {
  suspendCheckpointPath,
  hasSuspendCheckpoint,
  deleteSuspendCheckpoint,
} from '../../../lib/SuspendCheckpoint.js';
import {
  SUSPEND_TIMEOUT_MS,
  parseZoneConfiguration,
  bootFromCheckpoint,
  settleBootedZone,
  waitForZoneDown,
  tryQgaShutdown,
} from './ZoneLifecycleHelpers.js';

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
 * Execute zone start task. A zone holding a suspend checkpoint resumes from
 * it (the Go agent's saved-state semantics: start restores); a checkpoint
 * that refuses to restore is discarded — the fresh boot advances the disks,
 * so resuming from it later would time-travel — and the start proceeds,
 * narrated. With experimental features off the checkpoint is discarded
 * without a restore attempt (the same time-travel rule).
 * @param {string} zoneName - Name of zone to start
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeStartTask = async zoneName => {
  const zone = await Zones.findOne({ where: { name: zoneName } });
  const { zonepath } = parseZoneConfiguration(zone);

  let resumed = false;
  let result;
  if (zonepath && (await hasSuspendCheckpoint(zonepath))) {
    if (config.get('experimental.enabled')) {
      result = await bootFromCheckpoint(zoneName, zonepath);
      resumed = result.success;
      if (!resumed) {
        log.task.warn('Checkpoint resume failed — discarding the checkpoint and booting fresh', {
          zone_name: zoneName,
          error: result.error,
        });
        await deleteSuspendCheckpoint(zonepath);
      }
    } else {
      log.task.warn(
        'Suspend checkpoint found but experimental features are disabled — discarding it and booting fresh',
        { zone_name: zoneName }
      );
      await deleteSuspendCheckpoint(zonepath);
    }
  }
  if (!resumed) {
    result = await executeCommand(`pfexec zoneadm -z ${zoneName} boot`);
  }

  if (result.success) {
    await settleBootedZone(zoneName, zonepath);
    return {
      success: true,
      message: resumed
        ? `Zone ${zoneName} resumed from its suspend checkpoint`
        : `Zone ${zoneName} started successfully`,
    };
  }
  return {
    success: false,
    error: `Failed to start zone ${zoneName}: ${result.error}`,
  };
};

/**
 * Execute zone stop task — the graceful-stop ladder (the Go agent's shape,
 * bhyve rungs): qga guest-shutdown when the agent answers, then zoneadm
 * shutdown (ACPI), then halt.
 * @param {string} zoneName - Name of zone to stop
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeStopTask = async zoneName => {
  const zone = await Zones.findOne({ where: { name: zoneName } });

  let result = { success: zone ? await tryQgaShutdown(zone) : false };

  if (!result.success) {
    result = await executeCommand(`pfexec zoneadm -z ${zoneName} shutdown`);
  }

  if (!result.success) {
    result = await executeCommand(`pfexec zoneadm -z ${zoneName} halt`);
  }

  if (result.success) {
    await Zones.update(
      {
        status: 'installed',
        last_seen: new Date(),
      },
      { where: { name: zoneName } }
    );

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
 * Execute zone reset task — the hard bounce (the Go agent's reset verb).
 * zoneadm reboot skips any in-guest shutdown: the zone halts and boots in one
 * operation, brand-agnostic (bhyvectl --force-reset would cover bhyve only).
 * @param {string} zoneName - Name of zone to reset
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeResetTask = async zoneName => {
  const result = await executeCommand(`pfexec zoneadm -z ${zoneName} reboot`);

  if (result.success) {
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
      message: `Zone ${zoneName} reset successfully`,
    };
  }
  return {
    success: false,
    error: `Failed to reset zone ${zoneName}: ${result.error}`,
  };
};

/**
 * Execute zone suspend task — checkpoint a running bhyve machine to disk
 * (`bhyvectl --suspend=<statefile>`; the Go agent's savestate analog). The
 * state write completes when the bhyve process exits and the zone leaves
 * running — this only WAITS for that (halting mid-save would corrupt the
 * checkpoint), then closes the zone container out and marks the row
 * suspended. NOTE: the flag is dev-marked in bhyvectl — statefiles may not
 * survive platform upgrades; resume falls back to a fresh boot.
 * @param {string} zoneName - Name of zone to suspend
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeSuspendTask = async zoneName => {
  const zone = await Zones.findOne({ where: { name: zoneName } });
  const { zonepath } = parseZoneConfiguration(zone);
  if (!zonepath) {
    return {
      success: false,
      error: `Zone ${zoneName} has no zonepath — nowhere to place the suspend checkpoint`,
    };
  }
  const statefile = suspendCheckpointPath(zonepath);

  await deleteSuspendCheckpoint(zonepath);

  const result = await executeCommand(
    `pfexec bhyvectl --vm=${zoneName} --suspend=${statefile}`,
    SUSPEND_TIMEOUT_MS
  );
  if (!result.success) {
    return { success: false, error: `Failed to suspend zone ${zoneName}: ${result.error}` };
  }

  const down = await waitForZoneDown(zoneName, Date.now() + SUSPEND_TIMEOUT_MS);
  if (!down) {
    return {
      success: false,
      error: `Zone ${zoneName} did not stop after the checkpoint request — suspend state unknown, not marking suspended`,
    };
  }

  const checkpoint = await executeCommand(`pfexec ls ${statefile}`);
  if (!checkpoint.success) {
    return {
      success: false,
      error: `bhyvectl produced no checkpoint at ${statefile} — treat the zone as powered off, not suspended`,
    };
  }

  const halt = await executeCommand(`pfexec zoneadm -z ${zoneName} halt`);
  if (!halt.success) {
    log.task.debug('Post-suspend halt declined (zone already settled)', {
      zone_name: zoneName,
      error: halt.error,
    });
  }

  await Zones.update({ status: 'suspended', last_seen: new Date() }, { where: { name: zoneName } });
  await terminateVncSession(zoneName);

  log.task.info('Zone suspended', { zone_name: zoneName, statefile });
  return {
    success: true,
    message: `Zone ${zoneName} suspended — checkpoint at ${statefile}`,
  };
};

/**
 * Execute zone resume task — boot from the suspend checkpoint. The explicit
 * verb never falls back to a fresh boot: a restore failure keeps the
 * checkpoint for diagnosis (start is the verb that discards and boots fresh).
 * @param {string} zoneName - Name of zone to resume
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeResumeTask = async zoneName => {
  const zone = await Zones.findOne({ where: { name: zoneName } });
  const { zonepath } = parseZoneConfiguration(zone);
  if (!zonepath) {
    return { success: false, error: `Zone ${zoneName} has no zonepath — nothing to resume` };
  }
  if (!(await hasSuspendCheckpoint(zonepath))) {
    return {
      success: false,
      error: `Zone ${zoneName} has no suspend checkpoint — nothing to resume`,
    };
  }

  const result = await bootFromCheckpoint(zoneName, zonepath);
  if (!result.success) {
    return {
      success: false,
      error: `Failed to resume zone ${zoneName}: ${result.error} — the checkpoint is preserved at ${suspendCheckpointPath(zonepath)} (it may not match the current bhyve; start discards it and boots fresh)`,
    };
  }

  await settleBootedZone(zoneName, zonepath);
  return {
    success: true,
    message: `Zone ${zoneName} resumed from its suspend checkpoint`,
  };
};

/**
 * Execute zone restart task
 * @param {string} zoneName - Name of zone to restart
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRestartTask = async zoneName => {
  const stopResult = await executeStopTask(zoneName);
  if (!stopResult.success) {
    return stopResult;
  }

  await new Promise(resolve => {
    setTimeout(resolve, 2000);
  });

  return executeStartTask(zoneName);
};
