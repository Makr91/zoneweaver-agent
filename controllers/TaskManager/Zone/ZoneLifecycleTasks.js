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
  isGuestAgentEnabled,
  guestSocketPath,
  runGuestCommand,
  readExtraValue,
} from '../../../lib/QemuGuestAgent.js';
import { getZoneConfig as fetchZoneConfig } from '../../../lib/ZoneConfigUtils.js';
import {
  suspendCheckpointPath,
  hasSuspendCheckpoint,
  deleteSuspendCheckpoint,
} from '../../../lib/SuspendCheckpoint.js';

/**
 * Grace the qga guest-shutdown rung gets before the ladder escalates to
 * zoneadm, and the poll cadence while waiting for the guest to power off.
 */
const QGA_SHUTDOWN_WAIT_MS = 45000;
const QGA_POLL_INTERVAL_MS = 3000;

/**
 * Writing (suspend) or restoring (resume boot) a big-RAM guest's state takes
 * real time — both legs get the same generous window.
 */
const SUSPEND_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Parse a zone row's configuration column (JSON string or object).
 * @param {Object|null} zone - Zone DB record
 * @returns {Object} Parsed configuration ({} when unreadable)
 */
const parseZoneConfiguration = zone => {
  let zoneConfig = zone?.configuration || {};
  if (typeof zoneConfig === 'string') {
    try {
      zoneConfig = JSON.parse(zoneConfig);
    } catch (e) {
      log.task.warn('Failed to parse zone configuration', { error: e.message });
      zoneConfig = {};
    }
  }
  return zoneConfig;
};

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
 * Strip the `-r <statefile>` resume flag from the zone's `extra` attr (the
 * attr is deleted when emptied) — a boot flag pointing at a consumed or bad
 * checkpoint must never survive to the next boot. Failures narrate only: the
 * boot outcome already happened.
 * @param {string} zoneName - Zone name
 * @param {string} statefile - Checkpoint path the flag names
 */
const stripResumeToken = async (zoneName, statefile) => {
  try {
    const liveConfig = await fetchZoneConfig(zoneName);
    const existingExtra = readExtraValue(liveConfig);
    const stripped = existingExtra.split(`-r ${statefile}`).join('').replace(/\s+/g, ' ').trim();
    if (stripped === existingExtra.trim()) {
      return;
    }
    const command = stripped
      ? `select attr name=extra; set value=\\"${stripped}\\"; end;`
      : `remove attr name=extra;`;
    const result = await executeCommand(`pfexec zonecfg -z ${zoneName} "${command}"`);
    if (!result.success) {
      log.task.warn('Failed to strip the resume flag from extra', {
        zone_name: zoneName,
        error: result.error,
      });
    }
  } catch (error) {
    log.task.warn('Failed to strip the resume flag from extra', {
      zone_name: zoneName,
      error: error.message,
    });
  }
};

/**
 * Boot the zone from its suspend checkpoint: wire `-r <statefile>` into the
 * `extra` attr (the bhyve brand passes extra args verbatim), boot, ALWAYS
 * strip the flag again, and delete the checkpoint only after a successful
 * restore. A failed restore keeps the checkpoint — the caller decides whether
 * to discard it.
 * @param {string} zoneName - Zone name
 * @param {string} zonepath - Zone's zonepath
 * @returns {Promise<{success: boolean, error?: string}>}
 */
const bootFromCheckpoint = async (zoneName, zonepath) => {
  const statefile = suspendCheckpointPath(zonepath);

  let existingExtra;
  try {
    existingExtra = readExtraValue(await fetchZoneConfig(zoneName));
  } catch (error) {
    return { success: false, error: `Failed to read zone configuration: ${error.message}` };
  }
  const resumeToken = `-r ${statefile}`;
  if (!existingExtra.includes(resumeToken)) {
    const value = existingExtra ? `${existingExtra} ${resumeToken}` : resumeToken;
    const command = existingExtra
      ? `select attr name=extra; set value=\\"${value}\\"; end;`
      : `add attr; set name=extra; set value=\\"${value}\\"; set type=string; end;`;
    const wired = await executeCommand(`pfexec zonecfg -z ${zoneName} "${command}"`);
    if (!wired.success) {
      return { success: false, error: `Failed to wire the resume flag: ${wired.error}` };
    }
  }

  const boot = await executeCommand(`pfexec zoneadm -z ${zoneName} boot`, SUSPEND_TIMEOUT_MS);
  await stripResumeToken(zoneName, statefile);
  if (!boot.success) {
    return { success: false, error: boot.error };
  }
  await deleteSuspendCheckpoint(zonepath);
  log.task.info('Zone resumed from suspend checkpoint', { zone_name: zoneName });
  return { success: true };
};

/**
 * Fix zonepath permissions after boot (zoneadm resets to 700) and mark the
 * zone running in the database — the shared tail of every boot flavor.
 * @param {string} zoneName - Zone name
 * @param {string} [zonepath] - Zone's zonepath
 */
const settleBootedZone = async (zoneName, zonepath) => {
  if (zonepath) {
    const chmodResult = await executeCommand(`pfexec chmod 755 ${zonepath}`);
    if (!chmodResult.success) {
      log.task.warn('Failed to set zonepath permissions after boot', {
        zonepath,
        error: chmodResult.error,
      });
    }
  }
  await Zones.update(
    {
      status: 'running',
      last_seen: new Date(),
      is_orphaned: false,
    },
    { where: { name: zoneName } }
  );
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
 * Whether the zone has left the running/shutting_down states.
 * @param {string} zoneName - Zone name
 * @returns {Promise<boolean>}
 */
const zoneIsDown = async zoneName => {
  const result = await executeCommand(`pfexec zoneadm -z ${zoneName} list -p`);
  if (!result.success) {
    return true;
  }
  const [, , state] = result.output.split(':');
  return state !== 'running' && state !== 'shutting_down';
};

/**
 * Poll until the zone is down or the deadline passes.
 * @param {string} zoneName - Zone name
 * @param {number} deadline - Epoch ms cutoff
 * @returns {Promise<boolean>} True when the zone stopped in time
 */
const waitForZoneDown = async (zoneName, deadline) => {
  if (await zoneIsDown(zoneName)) {
    return true;
  }
  if (Date.now() > deadline) {
    return false;
  }
  await new Promise(resolve => {
    setTimeout(resolve, QGA_POLL_INTERVAL_MS);
  });
  return waitForZoneDown(zoneName, deadline);
};

/**
 * Rung one of the graceful-stop ladder: an in-guest shutdown through the qga
 * channel. Fires only when the guest-agent surface is enabled AND discovery
 * saw the agent answering — everything else falls straight through to
 * zoneadm, exactly the pre-ladder behavior.
 * @param {Object} zone - Zone DB record
 * @returns {Promise<boolean>} True when the guest powered itself off in time
 */
const tryQgaShutdown = async zone => {
  if (!isGuestAgentEnabled()) {
    return false;
  }
  let zoneConfig = zone.configuration || {};
  if (typeof zoneConfig === 'string') {
    try {
      zoneConfig = JSON.parse(zoneConfig);
    } catch {
      zoneConfig = {};
    }
  }
  if (!zoneConfig.guest_info?.agent_responding || !zoneConfig.zonepath) {
    return false;
  }
  try {
    await runGuestCommand(
      guestSocketPath(zoneConfig.zonepath),
      'guest-shutdown',
      { mode: 'powerdown' },
      5000
    );
  } catch (error) {
    log.task.debug('qga guest-shutdown rung failed — escalating to zoneadm', {
      zone_name: zone.name,
      error: error.message,
    });
    return false;
  }
  const stopped = await waitForZoneDown(zone.name, Date.now() + QGA_SHUTDOWN_WAIT_MS);
  if (stopped) {
    log.task.info('Zone stopped via qga guest-shutdown', { zone_name: zone.name });
  }
  return stopped;
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

  // Rung two: graceful zoneadm shutdown
  if (!result.success) {
    result = await executeCommand(`pfexec zoneadm -z ${zoneName} shutdown`);
  }

  // Rung three: halt
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

  // A leftover checkpoint from an earlier cycle is stale by definition here
  // (the zone is running) — clear it before writing the new one.
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

  // Close out the zone container; the brand usually settles it on its own,
  // so a declined halt just narrates.
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
