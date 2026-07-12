/**
 * @fileoverview Terminal Session Lifecycle Controller for Zoneweaver Agent
 * @description REST handlers for the /term host-terminal family — starting,
 * inspecting, listing, and stopping pseudo-terminal sessions. One wire with
 * the Go agent: POST /term/start mints the session row, the /term/{id}
 * WebSocket attaches to it, DELETE /term/sessions/{id}/stop tears it down.
 */

import TerminalSessions from '../../models/TerminalSessionModel.js';
import { log, createTimer } from '../../lib/Logger.js';
import {
  activePtyProcesses,
  createSessionRecord,
  spawnPtyProcessAsync,
} from './utils/SessionHelpers.js';

/**
 * @swagger
 * /term/start:
 *   post:
 *     summary: Start a terminal session
 *     description: |
 *       Mints a new host pseudo-terminal session and answers the session row.
 *       The PTY spawns asynchronously; connect the `/term/{id}` WebSocket to
 *       attach (it waits for the PTY while the session is `connecting`).
 *     tags: [Terminal]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               machine_name:
 *                 type: string
 *                 description: Machine name this terminal session is associated with
 *                 example: "myzone"
 *     responses:
 *       200:
 *         description: The created session row.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TerminalSession'
 *       500:
 *         description: Failed to start terminal session.
 */
export const startTerminalSession = async (req, res) => {
  const timer = createTimer('terminal_session_start');
  try {
    const { machine_name } = req.body || {};

    const session = await createSessionRecord(machine_name);

    // Start PTY asynchronously - DON'T AWAIT (key optimization!)
    spawnPtyProcessAsync(session).catch(error => {
      log.websocket.error('Async PTY spawn failed', {
        session_id: session.id,
        error: error.message,
      });
    });

    timer.end();

    // The session row IS the answer (the Go agent's /term/start shape).
    return res.json(session);
  } catch (error) {
    log.websocket.error('Terminal session start failed', {
      error: error.message,
      duration_ms: timer.end(),
    });
    return res.status(500).json({
      error: 'Failed to start terminal session',
    });
  }
};

/**
 * @swagger
 * /term/sessions/{sessionId}:
 *   get:
 *     summary: Get terminal session information
 *     description: Retrieves information about a specific terminal session.
 *     tags: [Terminal]
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
 *               $ref: '#/components/schemas/TerminalSession'
 *       404:
 *         description: Session not found.
 */
export const getTerminalSessionInfo = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await TerminalSessions.findByPk(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Terminal session not found' });
    }

    return res.json(session);
  } catch (error) {
    log.database.error('Error getting terminal session info', {
      error: error.message,
      session_id: req.params.sessionId,
    });
    return res.status(500).json({ error: 'Failed to get terminal session info' });
  }
};

/**
 * @swagger
 * /term/sessions/{sessionId}/stop:
 *   delete:
 *     summary: Stop a terminal session
 *     description: Terminates a specific terminal session.
 *     tags: [Terminal]
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
export const stopTerminalSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const ptyProcess = activePtyProcesses.get(sessionId);

    if (ptyProcess) {
      ptyProcess.kill();
      activePtyProcesses.delete(sessionId);
    }

    const session = await TerminalSessions.findByPk(sessionId);
    if (!session && !ptyProcess) {
      return res.status(404).json({ error: 'Terminal session not found' });
    }
    if (session) {
      await session.update({ status: 'closed' });
    }

    return res.json({ success: true, message: 'Terminal session stopped.' });
  } catch (error) {
    log.websocket.error('Error stopping terminal session', {
      error: error.message,
      session_id: req.params.sessionId,
    });
    return res.status(500).json({ error: 'Failed to stop terminal session' });
  }
};

/**
 * @swagger
 * /term/{sessionId}:
 *   get:
 *     summary: Establish a WebSocket connection for a terminal session
 *     description: |
 *       This endpoint is used to upgrade a standard HTTP GET request to a WebSocket connection for an interactive terminal session.
 *       It is not a traditional REST endpoint and will not return a standard HTTP response. Instead, it will return a 101 Switching Protocols response if successful.
 *
 *       **Connection Process:**
 *       1. Start a new terminal session by making a `POST` request to `/term/start`.
 *       2. Extract the `id` from the answered session row.
 *       3. Use the `id` to construct the WebSocket URL (e.g., `wss://your-host/term/{id}?ticket=...`).
 *       4. Establish a WebSocket connection to this URL.
 *
 *       **Note:** WebSocket upgrades authenticate via a short-lived ticket from `GET /ws-ticket` (verifyApiKey never runs on upgrade requests).
 *     tags: [Terminal]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The ID of the terminal session to connect to.
 *     responses:
 *       101:
 *         description: Switching protocols to WebSocket. This indicates a successful upgrade.
 *       404:
 *         description: Not Found. The requested terminal session does not exist or is not active.
 */

/**
 * @swagger
 * /term/sessions:
 *   get:
 *     summary: List all terminal sessions
 *     description: Retrieves a list of all terminal sessions.
 *     tags: [Terminal]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: A list of terminal sessions.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/TerminalSession'
 */
export const listTerminalSessions = async (req, res) => {
  void req;
  try {
    const sessions = await TerminalSessions.findAll({
      order: [['created_at', 'DESC']],
    });
    return res.json(sessions);
  } catch (error) {
    log.database.error('Error listing terminal sessions', {
      error: error.message,
    });
    return res.status(500).json({ error: 'Failed to list terminal sessions' });
  }
};
