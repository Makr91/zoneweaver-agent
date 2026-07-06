/**
 * @fileoverview Log stream session endpoints — REST lifecycle (start/list/
 * stop/info) and the orphaned-session cleanup task.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { v4 as uuidv4 } from 'uuid';
import { WebSocket } from 'ws';
import { Op } from 'sequelize';
import config from '../../config/ConfigLoader.js';
import LogStreamSession from '../../models/LogStreamSessionModel.js';
import { log, createTimer } from '../../lib/Logger.js';
import {
  activeSessions,
  validateLogFileAccess,
  isBinaryFile,
  findLogFile,
} from './utils/StreamHelpers.js';

/**
 * @swagger
 * /system/logs/{logname}/stream/start:
 *   post:
 *     summary: Start log stream session
 *     description: Creates a new log streaming session for WebSocket connection
 *     tags: [Log Streaming]
 *     parameters:
 *       - in: path
 *         name: logname
 *         required: true
 *         schema:
 *           type: string
 *         description: Log file name to stream
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               follow_lines:
 *                 type: integer
 *                 default: 50
 *                 description: Initial number of lines to show
 *               grep_pattern:
 *                 type: string
 *                 description: Filter pattern for log lines
 *     responses:
 *       200:
 *         description: Log stream session created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 session_id:
 *                   type: string
 *                 websocket_url:
 *                   type: string
 *                 logname:
 *                   type: string
 *                 log_path:
 *                   type: string
 *                 follow_lines:
 *                   type: integer
 *                 grep_pattern:
 *                   type: string
 *                   nullable: true
 *                 status:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: Log file not found
 *       400:
 *         description: Invalid parameters or security violation
 *       429:
 *         description: Maximum concurrent log streams reached
 *       503:
 *         description: System logs are disabled in configuration
 *       500:
 *         description: Failed to create stream session
 */
export const startLogStream = async (req, res) => {
  try {
    const { logname } = req.params;
    const { follow_lines = 50, grep_pattern } = req.body || {};
    const logsConfig = config.getSystemLogs();

    if (!logsConfig?.enabled) {
      return res.status(503).json({
        error: 'System logs are disabled in configuration',
      });
    }

    // Find the log file in allowed paths
    const logPath = await findLogFile(logname, logsConfig.allowed_paths);
    if (!logPath) {
      return res.status(404).json({
        error: `Log file '${logname}' not found in allowed directories`,
      });
    }

    // Security validation
    const securityCheck = await validateLogFileAccess(logPath, logsConfig);
    if (!securityCheck.allowed) {
      return res.status(400).json({
        error: securityCheck.reason,
      });
    }

    // Check if file is binary - refuse to stream binary files
    const isBinary = await isBinaryFile(logPath);
    if (isBinary) {
      return res.status(400).json({
        error: `Cannot stream log file '${logname}' - file contains binary data`,
        details: 'Binary files are not supported for streaming',
        logname,
        suggestion: 'Use system tools like hexdump or strings for binary file analysis',
      });
    }

    // Check concurrent session limit
    if (activeSessions.size >= (logsConfig.max_concurrent_streams || 10)) {
      return res.status(429).json({
        error: 'Maximum concurrent log streams reached',
      });
    }

    const sessionId = uuidv4();
    const cookie = `logstream_${Date.now()}_${sessionId}`;

    // Create session record
    await LogStreamSession.create({
      session_id: sessionId,
      cookie,
      logname,
      log_path: logPath,
      follow_lines,
      grep_pattern: grep_pattern || null,
      status: 'created',
      created_at: new Date(),
    });

    const websocketUrl = `/logs/stream/${sessionId}`;

    log.websocket.info('Log stream session created', {
      session_id: sessionId,
      logname,
      log_path: logPath,
      follow_lines,
      grep_pattern,
    });

    return res.json({
      session_id: sessionId,
      websocket_url: websocketUrl,
      logname,
      log_path: logPath,
      follow_lines,
      grep_pattern: grep_pattern || null,
      status: 'created',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.websocket.error('Error starting log stream', {
      error: error.message,
      logname: req.params.logname,
    });
    return res.status(500).json({
      error: 'Failed to start log stream',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/logs/stream/sessions:
 *   get:
 *     summary: List active log stream sessions
 *     description: Returns list of currently active log streaming sessions
 *     tags: [Log Streaming]
 *     responses:
 *       200:
 *         description: Active log stream sessions
 *       500:
 *         description: Failed to list sessions
 */
export const listLogStreamSessions = async (req, res) => {
  void req;
  try {
    const sessions = await LogStreamSession.findAll({
      where: { status: 'active' },
      order: [['created_at', 'DESC']],
    });

    const activeSummary = Array.from(activeSessions.values()).map(session => ({
      session_id: session.sessionId,
      logname: session.logname,
      connected_at: session.connectedAt,
      lines_sent: session.linesSent,
      client_ip: session.clientIP || null,
    }));

    return res.json({
      sessions,
      active_sessions: activeSummary,
      total_active: activeSessions.size,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.database.error('Error listing log stream sessions', {
      error: error.message,
    });
    return res.status(500).json({
      error: 'Failed to list log stream sessions',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/logs/stream/{sessionId}/stop:
 *   delete:
 *     summary: Stop log stream session
 *     description: Stops an active log streaming session
 *     tags: [Log Streaming]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Stream session ID
 *     responses:
 *       200:
 *         description: Stream session stopped
 *       404:
 *         description: Session not found
 *       500:
 *         description: Failed to stop session
 */
export const stopLogStream = async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Get session from database
    const session = await LogStreamSession.findOne({
      where: { session_id: sessionId },
    });

    if (!session) {
      return res.status(404).json({
        error: `Log stream session ${sessionId} not found`,
      });
    }

    // Stop active session if running
    if (activeSessions.has(sessionId)) {
      const activeSession = activeSessions.get(sessionId);
      if (activeSession.tailProcess) {
        activeSession.tailProcess.kill();
      }
      if (activeSession.ws && activeSession.ws.readyState === WebSocket.OPEN) {
        activeSession.ws.close();
      }
      activeSessions.delete(sessionId);
    }

    // Update database record
    await session.update({
      status: 'stopped',
      stopped_at: new Date(),
    });

    log.websocket.info('Log stream session stopped', {
      session_id: sessionId,
    });

    return res.json({
      success: true,
      session_id: sessionId,
      message: 'Log stream session stopped successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.websocket.error('Error stopping log stream', {
      error: error.message,
      session_id: req.params.sessionId,
    });
    return res.status(500).json({
      error: 'Failed to stop log stream',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/logs/stream/{sessionId}:
 *   get:
 *     summary: Get log stream session info
 *     description: Returns status and metadata for a specific log streaming session
 *     tags: [Log Streaming]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Stream session ID
 *     responses:
 *       200:
 *         description: Log stream session info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 session_id:
 *                   type: string
 *                 logname:
 *                   type: string
 *                 log_path:
 *                   type: string
 *                 status:
 *                   type: string
 *                 active:
 *                   type: boolean
 *                 lines_sent:
 *                   type: integer
 *                 created_at:
 *                   type: string
 *                   format: date-time
 *                 connected_at:
 *                   type: string
 *                   format: date-time
 *                   nullable: true
 *                 disconnected_at:
 *                   type: string
 *                   format: date-time
 *                   nullable: true
 *                 grep_pattern:
 *                   type: string
 *                   nullable: true
 *                 follow_lines:
 *                   type: integer
 *                 client_ip:
 *                   type: string
 *                   nullable: true
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: Session not found
 *       500:
 *         description: Failed to get log stream info
 */
export const getLogStreamInfo = async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await LogStreamSession.findOne({
      where: { session_id: sessionId },
    });

    if (!session) {
      return res.status(404).json({
        error: `Log stream session ${sessionId} not found`,
      });
    }

    const activeSession = activeSessions.get(sessionId);
    const isActive = !!activeSession;

    return res.json({
      session_id: sessionId,
      logname: session.logname,
      log_path: session.log_path,
      status: session.status,
      active: isActive,
      lines_sent: activeSession?.linesSent || session.lines_sent || 0,
      created_at: session.created_at,
      connected_at: session.connected_at,
      disconnected_at: session.disconnected_at,
      grep_pattern: session.grep_pattern,
      follow_lines: session.follow_lines,
      client_ip: activeSession?.clientIP || null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.database.error('Error getting log stream info', {
      error: error.message,
      session_id: req.params.sessionId,
    });
    return res.status(500).json({
      error: 'Failed to get log stream info',
      details: error.message,
    });
  }
};

/**
 * Cleanup orphaned sessions
 * @description Removes old or inactive session records
 */
export const cleanupLogStreamSessions = async () => {
  const timer = createTimer('log_stream_cleanup');
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    // Clean up old database records
    const deletedCount = await LogStreamSession.destroy({
      where: {
        status: ['closed', 'error'],
        disconnected_at: { [Op.lt]: oneHourAgo },
      },
    });

    if (deletedCount > 0) {
      log.database.info('Log stream session cleanup completed', {
        deleted_records: deletedCount,
      });
    }

    // Clean up orphaned active sessions
    let orphanedCount = 0;
    for (const [sessionId, session] of activeSessions) {
      if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
        if (session.tailProcess && !session.tailProcess.killed) {
          session.tailProcess.kill();
        }
        activeSessions.delete(sessionId);
        orphanedCount++;
      }
    }

    if (orphanedCount > 0) {
      log.websocket.info('Orphaned log stream sessions cleaned up', {
        orphaned_sessions: orphanedCount,
      });
    }

    timer.end();
  } catch (error) {
    timer.end();
    log.database.error('Error during log stream cleanup', {
      error: error.message,
    });
  }
};
