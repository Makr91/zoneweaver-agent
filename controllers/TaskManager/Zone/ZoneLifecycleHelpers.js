import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import Zones from '../../../models/ZoneModel.js';
import {
  isGuestAgentEnabled,
  guestSocketPath,
  runGuestCommand,
  readExtraValue,
} from '../../../lib/QemuGuestAgent.js';
import { getZoneConfig as fetchZoneConfig } from '../../../lib/ZoneConfigUtils.js';
import { suspendCheckpointPath, deleteSuspendCheckpoint } from '../../../lib/SuspendCheckpoint.js';

/**
 * Grace the qga guest-shutdown rung gets before the ladder escalates to
 * zoneadm, and the poll cadence while waiting for the guest to power off.
 */
export const QGA_SHUTDOWN_WAIT_MS = 45000;
export const QGA_POLL_INTERVAL_MS = 3000;

/**
 * Writing (suspend) or restoring (resume boot) a big-RAM guest's state takes
 * real time — both legs get the same generous window.
 */
export const SUSPEND_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Parse a zone row's configuration column (JSON string or object).
 * @param {Object|null} zone - Zone DB record
 * @returns {Object} Parsed configuration ({} when unreadable)
 */
export const parseZoneConfiguration = zone => {
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
export const bootFromCheckpoint = async (zoneName, zonepath) => {
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
export const settleBootedZone = async (zoneName, zonepath) => {
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
export const waitForZoneDown = async (zoneName, deadline) => {
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
export const tryQgaShutdown = async zone => {
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
