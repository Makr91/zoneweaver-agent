/**
 * @fileoverview QEMU Guest Agent endpoints (/machines/{name}/guest/* — the guest-agent token)
 * @description Credential-less guest control over the zone's virtio-console QGA channel:
 * live IPs, exec, clean shutdown, osinfo — no SSH required. Wire shapes shared with the
 * Go agent. Config-gated by guest_agent.enabled; the channel itself exists only on zones
 * created with zones.guest_agent (or retrofitted via POST /machines/{name}/guest-agent/setup).
 */

import Zones from '../models/ZoneModel.js';
import { log } from '../lib/Logger.js';
import { validateZoneName } from '../lib/ZoneValidation.js';
import { parseConfiguration } from '../lib/ZoneConfigUtils.js';
import { executeCommand } from '../lib/CommandManager.js';
import {
  QGA_EXTRA_VALUE,
  isGuestAgentEnabled,
  guestSocketPath,
  runGuestCommand,
  readExtraAttr,
} from '../lib/QemuGuestAgent.js';
import { getSystemZoneStatus } from './ZoneManagement/ZoneQueryController.js';

const resolveGuestChannel = async (req, res) => {
  if (!isGuestAgentEnabled()) {
    res.status(503).json({ error: 'Guest agent channel is disabled' });
    return null;
  }
  const { machineName: zoneName } = req.params;
  if (!validateZoneName(zoneName)) {
    res.status(400).json({ error: 'Invalid zone name' });
    return null;
  }
  const zone = await Zones.findOne({ where: { name: zoneName } });
  if (!zone) {
    res.status(404).json({ error: 'Machine not found' });
    return null;
  }
  const zoneConfig = parseConfiguration(zone);
  if (!zoneConfig.zonepath) {
    res.status(400).json({ error: 'Machine has no zonepath yet — no guest-agent channel' });
    return null;
  }
  return { zoneName, zone, zoneConfig, socketPath: guestSocketPath(zoneConfig.zonepath) };
};

const requireRunning = async (channel, res) => {
  const status = await getSystemZoneStatus(channel.zoneName);
  if (status !== 'running') {
    res.status(400).json({ error: 'Machine is not running' });
    return false;
  }
  return true;
};

const guestCommand = async (req, res, execute, args, timeoutMs) => {
  const channel = await resolveGuestChannel(req, res);
  if (!channel) {
    return null;
  }
  if (!(await requireRunning(channel, res))) {
    return null;
  }
  try {
    const outcome = await runGuestCommand(channel.socketPath, execute, args, timeoutMs);
    return { channel, outcome };
  } catch (error) {
    log.api.warn('Guest agent command failed', {
      zone_name: channel.zoneName,
      command: execute,
      error: error.message,
    });
    res.status(502).json({
      error: `Guest agent did not answer (${error.message}) — the machine needs the guest-agent channel (POST /machines/{name}/guest-agent/setup) and qemu-ga running in the guest`,
    });
    return null;
  }
};

/**
 * @swagger
 * /machines/{machineName}/guest/ping:
 *   get:
 *     summary: Ping the guest agent
 *     tags: [Guest Agent]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Guest agent is responding
 *       502:
 *         description: Guest agent did not answer
 */
export const guestPing = async (req, res) => {
  const result = await guestCommand(req, res, 'guest-ping', null, 5000);
  if (!result) {
    return undefined;
  }
  return res.json({
    success: true,
    machine_name: result.channel.zoneName,
    message: 'Guest agent is responding',
  });
};

/**
 * @swagger
 * /machines/{machineName}/guest/osinfo:
 *   get:
 *     summary: Get the guest's own OS identity (guest-get-osinfo)
 *     tags: [Guest Agent]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Guest OS information
 */
export const guestOSInfo = async (req, res) => {
  const result = await guestCommand(req, res, 'guest-get-osinfo', null, 5000);
  if (!result) {
    return undefined;
  }
  return res.json({
    machine_name: result.channel.zoneName,
    osinfo: result.outcome.reply || null,
  });
};

/**
 * @swagger
 * /machines/{machineName}/guest/network:
 *   get:
 *     summary: Get the guest's live network interfaces (guest-network-get-interfaces)
 *     tags: [Guest Agent]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Live guest interfaces with real addresses
 */
export const guestNetwork = async (req, res) => {
  const result = await guestCommand(req, res, 'guest-network-get-interfaces', null, 5000);
  if (!result) {
    return undefined;
  }
  return res.json({
    machine_name: result.channel.zoneName,
    interfaces: result.outcome.reply || null,
  });
};

const decodeExecStatus = reply => {
  const status = { exited: Boolean(reply?.exited) };
  if (typeof reply?.exitcode === 'number') {
    status.exitcode = reply.exitcode;
  }
  if (typeof reply?.signal === 'number') {
    status.signal = reply.signal;
  }
  if (reply?.['out-data']) {
    status.stdout = Buffer.from(reply['out-data'], 'base64').toString('utf8');
  }
  if (reply?.['err-data']) {
    status.stderr = Buffer.from(reply['err-data'], 'base64').toString('utf8');
  }
  return status;
};

const pollExecUntilExit = (channel, pid, timeoutSeconds, res) => {
  const deadline = Date.now() + timeoutSeconds * 1000;

  const poll = async () => {
    let outcome;
    try {
      outcome = await runGuestCommand(channel.socketPath, 'guest-exec-status', { pid }, 5000);
    } catch (error) {
      return res
        .status(502)
        .json({ error: `Guest agent stopped answering while waiting: ${error.message}` });
    }
    const status = decodeExecStatus(outcome.reply);
    if (status.exited) {
      return res.json({
        success: true,
        machine_name: channel.zoneName,
        pid,
        ...status,
      });
    }
    if (Date.now() > deadline) {
      return res.json({
        success: true,
        machine_name: channel.zoneName,
        pid,
        exited: false,
        message: `Still running after ${timeoutSeconds}s — poll GET /machines/{name}/guest/exec/${pid}`,
      });
    }
    await new Promise(resolve => {
      setTimeout(resolve, 1000);
    });
    return poll();
  };

  return poll();
};

/**
 * @swagger
 * /machines/{machineName}/guest/exec:
 *   post:
 *     summary: Run a command in the guest (guest-exec)
 *     description: wait (default true) polls until exit or timeout_seconds (default 30, max 600); wait=false answers the pid for GET /machines/{name}/guest/exec/{pid}.
 *     tags: [Guest Agent]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [path]
 *             properties:
 *               path:
 *                 type: string
 *               args:
 *                 type: array
 *                 items:
 *                   type: string
 *               wait:
 *                 type: boolean
 *                 default: true
 *               timeout_seconds:
 *                 type: integer
 *                 default: 30
 *     responses:
 *       200:
 *         description: Command result (or pid when wait=false / still running)
 */
export const guestExec = async (req, res) => {
  const { path: execPath, args = [], wait, timeout_seconds } = req.body || {};
  if (!execPath) {
    return res
      .status(400)
      .json({ error: 'Body needs path (the guest executable) and optional args[]' });
  }
  const result = await guestCommand(
    req,
    res,
    'guest-exec',
    { path: execPath, arg: args, 'capture-output': true },
    10000
  );
  if (!result) {
    return undefined;
  }
  const pid = result.outcome.reply?.pid;
  if (typeof pid !== 'number') {
    return res.status(502).json({ error: 'Guest agent answered an unexpected exec shape' });
  }
  log.api.info('Guest exec', {
    zone_name: result.channel.zoneName,
    path: execPath,
    pid,
    user: req.entity.name,
  });

  if (wait === false) {
    return res.json({
      success: true,
      machine_name: result.channel.zoneName,
      pid,
      message: `Command started — poll GET /machines/{name}/guest/exec/${pid}`,
    });
  }
  const timeoutSeconds = Math.min(Math.max(Number(timeout_seconds) || 30, 1), 600);
  return pollExecUntilExit(result.channel, pid, timeoutSeconds, res);
};

/**
 * @swagger
 * /machines/{machineName}/guest/exec/{pid}:
 *   get:
 *     summary: Poll a guest-exec command's status (guest-exec-status)
 *     tags: [Guest Agent]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: pid
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Exec status with decoded stdout/stderr
 */
export const guestExecStatus = async (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return res.status(400).json({ error: 'Invalid pid' });
  }
  const result = await guestCommand(req, res, 'guest-exec-status', { pid }, 5000);
  if (!result) {
    return undefined;
  }
  return res.json({
    machine_name: result.channel.zoneName,
    pid,
    ...decodeExecStatus(result.outcome.reply),
  });
};

/**
 * @swagger
 * /machines/{machineName}/guest/shutdown:
 *   post:
 *     summary: Clean in-guest shutdown/reboot/halt (guest-shutdown)
 *     description: The guest may power off before replying — silence after delivery is success.
 *     tags: [Guest Agent]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mode:
 *                 type: string
 *                 enum: [powerdown, reboot, halt]
 *                 default: powerdown
 *     responses:
 *       200:
 *         description: Shutdown requested
 */
export const guestShutdown = async (req, res) => {
  const mode = req.body?.mode || 'powerdown';
  if (!['powerdown', 'reboot', 'halt'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be powerdown, reboot, or halt' });
  }
  const result = await guestCommand(req, res, 'guest-shutdown', { mode }, 5000);
  if (!result) {
    return undefined;
  }
  log.api.info('Guest shutdown requested', {
    zone_name: result.channel.zoneName,
    mode,
    user: req.entity.name,
  });
  return res.json({
    success: true,
    machine_name: result.channel.zoneName,
    mode,
    message: `Guest ${mode} requested through the guest agent`,
  });
};

/**
 * @swagger
 * /machines/{machineName}/guest-agent/setup:
 *   post:
 *     summary: Retrofit the guest-agent channel onto an existing machine
 *     description: |
 *       Adds the virtio-console extra attr (`-s 9,virtio-console,org.qemu.guest_agent.0=/tmp/qga.sock`)
 *       to the zone configuration — applies at the next zone boot. Creates carry it when the
 *       request sets zones.guest_agent. The guest needs qemu-ga on its virtio-serial port
 *       (Windows guests also need hostbridge=q35 for vioserial enumeration).
 *     tags: [Guest Agent]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Channel configured (takes effect on next boot)
 */
/**
 * Wire the qga virtio-console token into the zone's `extra` attr through
 * zonecfg's offline store: the token APPENDS to an existing value
 * (select-and-set when the attr exists, add when absent) — the ONE command
 * builder the setup endpoint and the PUT toggle share.
 * @param {string} zoneName - Zone name
 * @param {boolean} exists - Whether the extra attr already exists
 * @param {string} existingExtra - The attr's current value ('' when unset)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
const wireGuestAgentChannel = (zoneName, exists, existingExtra) => {
  const value = existingExtra ? `${existingExtra} ${QGA_EXTRA_VALUE}` : QGA_EXTRA_VALUE;
  const command = exists
    ? `select attr name=extra; set value=\\"${value}\\"; end;`
    : `add attr; set name=extra; set value=\\"${value}\\"; set type=string; end;`;
  return executeCommand(`pfexec zonecfg -z ${zoneName} "${command}"`);
};

export const guestAgentSetup = async (req, res) => {
  const channel = await resolveGuestChannel(req, res);
  if (!channel) {
    return undefined;
  }
  try {
    const { exists, value: existingExtra } = await readExtraAttr(channel.zoneName);
    if (existingExtra.includes('virtio-console')) {
      return res.json({
        success: true,
        machine_name: channel.zoneName,
        requires_restart: false,
        socket: channel.socketPath,
        message: 'Guest-agent channel is already configured',
      });
    }
    const result = await wireGuestAgentChannel(channel.zoneName, exists, existingExtra);
    if (!result.success) {
      return res
        .status(500)
        .json({ error: `Failed to configure the guest-agent channel: ${result.error}` });
    }
    log.api.info('Guest-agent channel configured', {
      zone_name: channel.zoneName,
      user: req.entity.name,
    });
    return res.json({
      success: true,
      machine_name: channel.zoneName,
      requires_restart: true,
      socket: channel.socketPath,
      message:
        'Guest-agent channel configured — applies at the next zone boot; the guest needs qemu-ga on its virtio-serial port (Windows guests need hostbridge=q35).',
    });
  } catch (error) {
    log.api.error('Guest-agent setup failed', {
      zone_name: channel.zoneName,
      error: error.message,
    });
    return res.status(500).json({ error: 'Failed to configure the guest-agent channel' });
  }
};

/**
 * Apply the PUT `guest_agent` toggle (shared contract with the Go agent):
 * true wires the virtio-console channel, false strips ONLY the qga token from
 * `extra` (the attr is deleted when emptied). zonecfg has an offline store, so
 * the toggle applies synchronously regardless of power state — the change
 * reaches the guest at its next boot. Already-in-state is a no-op.
 * @param {string} zoneName - Zone name
 * @param {boolean} enabled - Desired channel state
 * @returns {Promise<{changed: boolean}>}
 * @throws {Error} When the zonecfg apply fails
 */
export const applyGuestAgentToggle = async (zoneName, enabled) => {
  const { exists, value: existingExtra } = await readExtraAttr(zoneName);
  const hasChannel = existingExtra.includes('virtio-console');

  if (enabled) {
    if (hasChannel) {
      return { changed: false };
    }
    const result = await wireGuestAgentChannel(zoneName, exists, existingExtra);
    if (!result.success) {
      throw new Error(`Failed to configure the guest-agent channel: ${result.error}`);
    }
    log.api.info('Guest-agent channel configured via toggle', { zone_name: zoneName });
    return { changed: true };
  }

  if (!hasChannel) {
    return { changed: false };
  }
  // Strip only the qga token (slot number may differ on hand-tuned zones);
  // every other extra flag survives.
  const stripped = existingExtra
    .replace(/-s\s+\d+,virtio-console\S*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const command = stripped
    ? `select attr name=extra; set value=\\"${stripped}\\"; end;`
    : `remove attr name=extra;`;
  const result = await executeCommand(`pfexec zonecfg -z ${zoneName} "${command}"`);
  if (!result.success) {
    throw new Error(`Failed to remove the guest-agent channel: ${result.error}`);
  }
  log.api.info('Guest-agent channel removed via toggle', { zone_name: zoneName });
  return { changed: true };
};
