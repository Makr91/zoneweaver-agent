import ZloginSessions from '../models/ZloginSessionModel.js';
import Zones from '../models/ZoneModel.js';
import { log } from '../lib/Logger.js';
import { ptyManager } from '../lib/ZloginPtyManager.js';
import { createSessionBufferWriter } from '../lib/SessionBuffer.js';
import { sessionManager } from './ZloginSessionManager.js';

/**
 * @fileoverview Zlogin Session Controller for Zoneweaver Agent
 * @description Manages the lifecycle of zlogin pseudo-terminal sessions for zones.
 *              Uses shared PTY manager for multiplexing between automation and WebSocket clients.
 */

export const getZloginCleanupTask = () => ({
  name: 'zlogin_cleanup',
  description: 'Clean up closed zlogin sessions',
  model: ZloginSessions,
  where: {
    status: 'closed',
  },
});

export const startZloginSessionCleanup = () => {
  sessionManager.cleanupStaleSessions();
  setInterval(
    () => {
      sessionManager.cleanupStaleSessions();
    },
    30 * 60 * 1000
  );
};

/**
 * Create or reuse a zlogin session for a zone
 * @param {string} zoneName - The name of the zone to connect to
 * @returns {Promise<import('../models/ZloginSessionModel.js').default>} Session record
 */
const createOrReuseZloginSession = async zoneName => {
  const existingSession = await ZloginSessions.findOne({
    where: { zone_name: zoneName, status: 'active' },
  });

  if (existingSession && ptyManager.isAlive(zoneName)) {
    log.websocket.info('Reusing existing zlogin session', {
      zone_name: zoneName,
      session_id: existingSession.id,
    });
    await existingSession.update({ last_accessed: new Date() });
    return existingSession;
  }

  const ptySession = ptyManager.getOrCreate(zoneName);

  const session = await ZloginSessions.create({
    zone_name: zoneName,
    pid: ptySession.pid,
    status: 'active',
    automation_active: ptySession.automationActive,
  });

  log.websocket.info('Created new zlogin session', {
    zone_name: zoneName,
    session_id: session.id,
    pid: session.pid,
  });

  return session;
};

/**
 * @swagger
 * tags:
 *   name: Zlogin
 *   description: Manage zlogin sessions for machines
 * /machines/{machineName}/zlogin/start:
 *   post:
 *     summary: Start a new zlogin session
 *     description: Creates a new pseudo-terminal session for the specified machine (zone).
 *     tags: [Zlogin]
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
 *         description: Zlogin session started successfully.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ZloginSession'
 *       404:
 *         description: Machine not found.
 *       500:
 *         description: Failed to start zlogin session.
 */
export const startZloginSession = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;
    log.websocket.info('Starting zlogin session', { zone_name: zoneName });

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      log.websocket.warn('Zone not found', { zone_name: zoneName });
      return res.status(404).json({ error: 'Zone not found' });
    }

    if (zone.status !== 'running') {
      log.websocket.warn('Zone not running', {
        zone_name: zoneName,
        status: zone.status,
      });
      return res.status(400).json({ error: 'Zone is not running' });
    }

    const session = await createOrReuseZloginSession(zoneName);

    const automationActive = ptyManager.isAutomationActive(zoneName);

    log.websocket.info('Session ready', {
      zone_name: zoneName,
      session_id: session.id,
      automation_active: automationActive,
    });

    return res.json({
      ...session.toJSON(),
      automation_active: automationActive,
    });
  } catch (error) {
    log.websocket.error('Error starting zlogin session', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to start zlogin session' });
  }
};

/**
 * @swagger
 * /zlogin/sessions/{sessionId}:
 *   get:
 *     summary: Get zlogin session information
 *     description: Retrieves information about a specific zlogin session.
 *     tags: [Zlogin]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Session information retrieved successfully.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ZloginSession'
 *       404:
 *         description: Session not found.
 */
export const getZloginSessionInfo = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await ZloginSessions.findByPk(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Zlogin session not found' });
    }

    return res.json(session);
  } catch (error) {
    log.websocket.error('Error getting zlogin session info', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to get zlogin session info' });
  }
};

/**
 * @swagger
 * /zlogin/sessions/{sessionId}/stop:
 *   delete:
 *     summary: Stop a zlogin session
 *     description: Terminates a specific zlogin session.
 *     tags: [Zlogin]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Session stopped successfully.
 *       404:
 *         description: Session not found.
 */
export const stopZloginSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await ZloginSessions.findByPk(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const { zone_name } = session;

    await ptyManager.destroy(zone_name);

    await session.update({ status: 'closed' });

    log.websocket.info('Zlogin session stopped', {
      session_id: sessionId,
      zone_name,
    });

    return res.json({ success: true, message: 'Zlogin session stopped.' });
  } catch (error) {
    log.websocket.error('Error stopping zlogin session', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to stop zlogin session' });
  }
};

/**
 * @swagger
 * /zlogin/sessions:
 *   get:
 *     summary: List all zlogin sessions
 *     description: Retrieves a list of all zlogin sessions.
 *     tags: [Zlogin]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: A list of zlogin sessions.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ZloginSession'
 */
export const listZloginSessions = async (req, res) => {
  void req;
  try {
    const sessions = await ZloginSessions.findAll({
      order: [['created_at', 'DESC']],
    });
    res.json(sessions);
  } catch (error) {
    log.websocket.error('Error listing zlogin sessions', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to list zlogin sessions' });
  }
};

/**
 * Handles a new WebSocket connection for an existing zlogin session.
 * @param {import('ws').WebSocket} ws - The WebSocket connection object.
 * @param {string} sessionId - The ID of the zlogin session.
 */
export const handleZloginConnection = async (ws, sessionId) => {
  try {
    const session = await ZloginSessions.findByPk(sessionId);
    if (!session) {
      ws.send('Zlogin session not found.\r\n');
      ws.close();
      return;
    }

    const { zone_name } = session;

    if (!ptyManager.isAlive(zone_name)) {
      ws.send('Zlogin PTY not available.\r\n');
      ws.close();
      return;
    }

    log.websocket.info('[ZLOGIN-WS] WebSocket connected to zlogin session', {
      session_id: sessionId,
      zone_name,
    });

    if (session.session_buffer) {
      const bufferLines = session.session_buffer.split('\n');
      const contextLines = bufferLines.slice(-50);
      if (contextLines.length > 0) {
        ws.send('\r\n=== Session Reconnected - Last 50 lines ===\r\n');
        ws.send(contextLines.join('\r\n'));
        ws.send('\r\n=== Live Console ===\r\n');
      }
    }

    const automationActive = ptyManager.isAutomationActive(zone_name);
    if (automationActive) {
      ws.send('\r\n[⚠️  Automation is active on this console]\r\n\r\n');
    }

    await session.update({ last_accessed: new Date(), last_activity: new Date() });

    const bufferWriter = createSessionBufferWriter(session);

    const unsubscribe = ptyManager.subscribe(zone_name, data => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
        bufferWriter.append(data);
      }
    });

    ws.on('message', command => {
      try {
        ptyManager.write(zone_name, command.toString());
        bufferWriter.touch();
      } catch (error) {
        log.websocket.error('[ZLOGIN-WS] Error writing to PTY', {
          session_id: sessionId,
          zone_name,
          error: error.message,
        });
      }
    });

    ws.on('close', (code, reason) => {
      log.websocket.info('[ZLOGIN-WS] WebSocket closed', {
        session_id: sessionId,
        zone_name,
        code,
        reason: reason || 'none',
      });
      unsubscribe();
      bufferWriter.close();
    });

    ws.on('error', error => {
      log.websocket.error('[ZLOGIN-WS] WebSocket error', {
        session_id: sessionId,
        zone_name,
        error: error.message,
      });
      unsubscribe();
      bufferWriter.close();
    });
  } catch (error) {
    log.websocket.error('[ZLOGIN-WS] Error handling zlogin connection', {
      session_id: sessionId,
      error: error.message,
      stack: error.stack,
    });
    try {
      ws.send(`Error: ${error.message}\r\n`);
      ws.close();
    } catch (sendError) {
      void sendError;
    }
  }
};
