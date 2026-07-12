/**
 * @fileoverview VNC Session Start Controller
 * @description Handles VNC session start operations, including healthy-session reuse
 * and new session spawn/validation
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import fs from 'fs';
import { spawn } from 'child_process';
import VncSessions from '../../models/VncSessionModel.js';
import Zones from '../../models/ZoneModel.js';
import { readZonecfgAttr } from '../../lib/ZoneConfigUtils.js';
import {
  directSuccessResponse,
  errorResponse,
} from '../SystemHostController/utils/ResponseHelpers.js';
import {
  validateZoneName,
  findAvailablePort,
  testVncConnection,
  validateStaticPort,
} from './utils/VncValidation.js';
import { sessionManager } from './utils/VncSessionManager.js';
import { log } from '../../lib/Logger.js';

/**
 * Handle existing VNC session reuse logic
 */
const handleExistingSession = async (req, res, zoneName, existingSessionInfo) => {
  log.websocket.debug('Found existing session', {
    zone_name: zoneName,
    pid: existingSessionInfo.pid,
    port: existingSessionInfo.port,
  });

  // Test if the session is healthy before killing it
  log.websocket.debug('Testing VNC connection health', { port: existingSessionInfo.port });
  const isHealthy = await testVncConnection(existingSessionInfo.port, 3);

  if (isHealthy) {
    log.websocket.info('HEALTHY SESSION FOUND: Reusing existing VNC session', {
      zone_name: zoneName,
    });

    // Update database last_accessed time for healthy session
    try {
      await VncSessions.update(
        { last_accessed: new Date() },
        { where: { zone_name: zoneName, status: 'active' } }
      );
    } catch (dbError) {
      log.websocket.warn('Failed to update database', {
        zone_name: zoneName,
        error: dbError.message,
      });
    }

    // Get the actual host IP for direct VNC access
    const [hostIP] = req.get('host').split(':');

    // Return existing healthy session immediately
    return directSuccessResponse(res, 'Healthy VNC session reused - instant access!', {
      machine_name: zoneName,
      console_url: `http://${hostIP}:${existingSessionInfo.port}/`,
      proxy_url: `${req.protocol}://${req.get('host')}/machines/${zoneName}/vnc/console`,
      session_id: existingSessionInfo.pid,
      status: 'active',
      web_port: existingSessionInfo.port,
      direct_access: true,
      started_at: existingSessionInfo.timestamp,
      reused_session: true,
    });
  }

  log.websocket.info('UNHEALTHY SESSION DETECTED: Session exists but not responding', {
    zone_name: zoneName,
  });
  return null; // Will proceed to create new session
};

/**
 * Validate and finalize VNC session
 */
const validateAndFinalizeSession = async (req, res, options) => {
  const { zoneName, vncProcess, webPort, stdout, stderr, staticPort, bindHost, portSource } =
    options;
  // Wait for process to start and validate
  await new Promise(resolve => {
    setTimeout(resolve, 3000);
  });

  // Check if process failed
  if (vncProcess.exitCode !== null && vncProcess.exitCode !== 0) {
    log.websocket.error('VNC process failed', {
      exit_code: vncProcess.exitCode,
      stderr,
    });

    // Clean up PID file
    sessionManager.killSession(zoneName);

    if (vncProcess.exitCode === 125 && stderr.includes('Address already in use')) {
      throw new Error(`Port ${webPort} is already in use by another process`);
    }

    throw new Error(
      `VNC process failed with exit code ${vncProcess.exitCode}: ${stderr || 'Unknown error'}`
    );
  }

  // Test if VNC is responding
  log.websocket.debug('Testing VNC connection', { port: webPort });
  const isReady = await testVncConnection(webPort, 15);

  if (!isReady) {
    log.websocket.error('VNC server not responding', { port: webPort });
    // Clean up
    sessionManager.killSession(zoneName);
    throw new Error(`VNC server failed to start on port ${webPort}`);
  }

  log.websocket.info('VNC session started and verified', {
    zone_name: zoneName,
    port: webPort,
    pid: vncProcess.pid,
  });

  // Final process validation
  const isStillRunning = sessionManager.isProcessRunning(vncProcess.pid);
  if (!isStillRunning) {
    log.websocket.error('PROCESS DIED IMMEDIATELY', {
      pid: vncProcess.pid,
      zone_name: zoneName,
      stdout,
      stderr,
      exit_code: vncProcess.exitCode,
      killed: vncProcess.killed,
    });

    throw new Error(
      `VNC process died immediately after successful startup - check zadm vnc configuration for zone ${zoneName}`
    );
  }

  // Clean up any existing database entries for this zone first
  try {
    await VncSessions.destroy({
      where: { zone_name: zoneName },
    });
  } catch {
    log.websocket.warn('Failed to cleanup existing database entries', {
      zone_name: zoneName,
    });
  }

  // Update database with session info
  await VncSessions.create({
    zone_name: zoneName,
    web_port: webPort,
    host_ip: '127.0.0.1',
    requested_port: staticPort || null,
    console_host: bindHost,
    port_source: portSource,
    process_id: vncProcess.pid,
    status: 'active',
    created_at: new Date(),
    last_accessed: new Date(),
  });

  // Get the actual host IP for direct VNC access
  const [hostIP] = req.get('host').split(':');

  return directSuccessResponse(res, 'VNC session started successfully', {
    machine_name: zoneName,
    console_url: `http://${hostIP}:${webPort}/`,
    proxy_url: `${req.protocol}://${req.get('host')}/machines/${zoneName}/vnc/console`,
    session_id: vncProcess.pid,
    status: 'active',
    web_port: webPort,
    direct_access: true,
  });
};

/**
 * Create new VNC session
 */
const createNewVncSession = async (req, res, zoneName) => {
  // Static port/bind pins are custom zonecfg attrs — they ride the zone config
  // itself (export/migrate with the zone; the PUT consoleport/consolehost
  // knobs write them, create materializes settings.consoleport into them).
  const [portAttr, hostAttr] = await Promise.all([
    readZonecfgAttr(zoneName, 'consoleport'),
    readZonecfgAttr(zoneName, 'consolehost'),
  ]);
  const parsedPort = Number(portAttr.value);
  const staticPort = portAttr.exists && Number.isInteger(parsedPort) ? parsedPort : null;
  const bindHost = hostAttr.exists && hostAttr.value ? hostAttr.value : '0.0.0.0';

  let webPort;
  let portSource = 'dynamic';

  // Static port allocation
  if (staticPort) {
    const validation = await validateStaticPort(staticPort, zoneName);
    if (!validation.available) {
      return res.status(409).json({
        error: 'Static port unavailable',
        port: staticPort,
        reason: validation.reason,
      });
    }
    webPort = staticPort;
    portSource = 'static';
    log.websocket.info('Using static VNC port', {
      zone_name: zoneName,
      port: webPort,
      bind_host: bindHost,
    });
  } else {
    // Dynamic port allocation (existing behavior)
    webPort = await findAvailablePort();
    log.websocket.debug('Allocated dynamic VNC port', {
      zone_name: zoneName,
      port: webPort,
    });
  }

  const netport = `${bindHost}:${webPort}`;

  log.websocket.info('Spawning VNC process', {
    command: `pfexec zadm vnc -w ${netport} ${zoneName}`,
    zone_name: zoneName,
    port: webPort,
  });

  // Spawn VNC process (detached)
  const vncProcess = spawn('pfexec', ['zadm', 'vnc', '-w', netport, zoneName], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  log.websocket.info('VNC process spawned', {
    pid: vncProcess.pid,
    zone_name: zoneName,
  });

  // Write PID file immediately
  sessionManager.writeSessionInfo(zoneName, vncProcess.pid, 'webvnc', netport);

  // Set up output handling
  let stdout = '';
  let stderr = '';

  vncProcess.stdout.on('data', data => {
    stdout += data.toString();
    log.websocket.debug('VNC stdout', { data: data.toString().trim() });
  });

  vncProcess.stderr.on('data', data => {
    stderr += data.toString();
    log.websocket.debug('VNC stderr', { data: data.toString().trim() });
  });

  vncProcess.on('exit', (code, signal) => {
    log.websocket.error('VNC process exited', {
      pid: vncProcess.pid,
      zone_name: zoneName,
      exit_code: code,
      signal,
      stdout,
      stderr,
    });

    // Clean up PID file if process exits
    const pidFile = sessionManager.getPidFilePath(zoneName);
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
      log.websocket.debug('Cleaned up PID file for exited process', {
        pid: vncProcess.pid,
      });
    }
  });

  // Detach the process
  vncProcess.unref();

  const result = await validateAndFinalizeSession(req, res, {
    zoneName,
    vncProcess,
    webPort,
    stdout,
    stderr,
    staticPort,
    bindHost,
    portSource,
  });
  return result;
};

/**
 * Handle VNC session start logic (split to reduce function complexity)
 */
const handleVncSessionStart = async (req, res, zoneName) => {
  // CHECK FOR EXISTING HEALTHY SESSION FIRST (PERFORMANCE OPTIMIZATION)
  log.websocket.debug('Checking for existing healthy session', { zone_name: zoneName });
  const existingSessionInfo = sessionManager.getSessionInfo(zoneName);

  if (existingSessionInfo) {
    const result = await handleExistingSession(req, res, zoneName, existingSessionInfo);
    if (result) {
      return result;
    }
  }

  // ONLY KILL IF SESSION IS UNHEALTHY OR MISSING
  log.websocket.debug('Cleaning up unhealthy/missing sessions', { zone_name: zoneName });

  // Only kill VNC processes we manage (conservative approach)
  const sessionInfoForCleanup = sessionManager.getSessionInfo(zoneName);
  if (sessionInfoForCleanup) {
    // Kill the specific managed session using session manager
    await sessionManager.killSession(zoneName);
    log.websocket.debug('Cleaned up managed VNC session', {
      zone_name: zoneName,
      port: sessionInfoForCleanup.port,
    });
  }
  // No fallback pattern killing - only clean up sessions we manage

  // Wait for processes to terminate
  await new Promise(resolve => {
    setTimeout(resolve, 2000);
  });

  const result = await createNewVncSession(req, res, zoneName);
  return result;
};

/**
 * @swagger
 * /machines/{machineName}/vnc/start:
 *   post:
 *     summary: Start VNC console session
 *     description: Starts a VNC console session for the specified machine (zone)
 *     tags: [VNC Console]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine
 *     responses:
 *       200:
 *         description: VNC session started successfully
 *       400:
 *         description: Invalid machine name or machine not running
 *       404:
 *         description: Machine not found
 *       409:
 *         description: VNC session already active
 *       500:
 *         description: Failed to start VNC session
 */
export const startVncSession = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;

    log.websocket.info('START VNC REQUEST', { zone_name: zoneName });

    if (!validateZoneName(zoneName)) {
      return errorResponse(res, 400, 'Invalid zone name');
    }

    // Check if zone exists and is running
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return errorResponse(res, 404, 'Zone not found');
    }

    if (zone.status !== 'running') {
      return errorResponse(res, 400, 'Zone must be running for VNC access', zone.status);
    }

    const result = await handleVncSessionStart(req, res, zoneName);
    return result;
  } catch (error) {
    log.websocket.error('VNC START ERROR', {
      zone_name: req.params.machineName,
      error: error.message,
      stack: error.stack,
    });

    return errorResponse(res, 500, 'Failed to start VNC session', error.message);
  }
};
