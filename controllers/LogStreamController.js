/**
 * @fileoverview Log Stream Controller for Zoneweaver Agent
 * @description Provides WebSocket streaming for real-time log file monitoring
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { WebSocket } from 'ws';
import { Op } from 'sequelize';
import fs from 'fs/promises';
import path from 'path';
import config from '../config/ConfigLoader.js';
import LogStreamSession from '../models/LogStreamSessionModel.js';
import { log, createTimer } from '../lib/Logger.js';

/**
 * Active log stream sessions
 * @type {Map<string, Object>}
 */
const activeSessions = new Map();

/**
 * Helper function to format file size
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted file size
 */
const formatFileSize = bytes => {
  const sizes = ['B', 'KB', 'MB', 'GB'];
  if (bytes === 0) {
    return '0 B';
  }
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(2)} ${sizes[i]}`;
};

/**
 * Helper function to validate log file access
 * @param {string} logPath - Full path to log file
 * @param {Object} logsConfig - System logs configuration
 * @returns {Object} Validation result
 */
const validateLogFileAccess = async (logPath, logsConfig) => {
  try {
    const stats = await fs.stat(logPath);

    // Check file size limit (more generous for streaming)
    const maxSizeBytes = logsConfig.security.max_file_size_mb * 2 * 1024 * 1024; // 2x limit for streaming
    if (stats.size > maxSizeBytes) {
      return {
        allowed: false,
        reason: `File too large for streaming: ${formatFileSize(stats.size)} exceeds limit`,
      };
    }

    // Check forbidden patterns
    const filename = path.basename(logPath);
    for (const pattern of logsConfig.security.forbidden_patterns) {
      const regex = new RegExp(pattern.replace('*', '.*'));
      if (regex.test(filename) || regex.test(logPath)) {
        return {
          allowed: false,
          reason: `File matches forbidden pattern: ${pattern}`,
        };
      }
    }

    return {
      allowed: true,
      fileSize: stats.size,
      modified: stats.mtime,
    };
  } catch (error) {
    return {
      allowed: false,
      reason: `Cannot access file: ${error.message}`,
    };
  }
};

/**
 * Helper function to detect if a file is binary
 * @param {string} filePath - Full path to file
 * @returns {Promise<boolean>} True if file appears to be binary
 */
const isBinaryFile = async filePath => {
  try {
    // Read first 8KB of file to check for binary content
    const fileHandle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await fileHandle.read(buffer, 0, 8192, 0);
    await fileHandle.close();

    if (bytesRead === 0) {
      return false;
    } // Empty file, treat as text

    const sample = buffer.slice(0, bytesRead);

    // Count null bytes - binary files typically have many null bytes
    const nullBytes = sample.filter(byte => byte === 0).length;
    const nullPercentage = nullBytes / bytesRead;

    // Consider binary if >1% null bytes or high percentage of control characters
    if (nullPercentage > 0.01) {
      return true;
    }

    // Check for excessive control characters (excluding common ones like \n, \r, \t)
    const controlBytes = sample.filter(
      byte =>
        (byte >= 1 && byte <= 8) || // Control chars except \t
        (byte >= 11 && byte <= 12) || // Control chars except \n
        (byte >= 14 && byte <= 31) || // Control chars except \r
        byte === 127 // DEL
    ).length;

    const controlPercentage = controlBytes / bytesRead;

    // Consider binary if >5% control characters
    return controlPercentage > 0.05;
  } catch (error) {
    // If we can't read the file, assume it's binary to be safe
    log.filesystem.warn('Cannot determine file type', {
      file_path: filePath,
      error: error.message,
    });
    return true;
  }
};

/**
 * Helper function to find log file in allowed paths
 * @param {string} logname - Log file name
 * @param {string[]} allowedPaths - Allowed directory paths
 * @returns {string|null} Full path to log file or null if not found
 */
const findLogFile = async (logname, allowedPaths) => {
  const checks = await Promise.all(
    allowedPaths.map(async dirPath => {
      try {
        const fullPath = path.join(dirPath, logname);
        await fs.access(fullPath, fs.constants.R_OK);
        return fullPath;
      } catch {
        return null;
      }
    })
  );
  return checks.find(p => p !== null) || null;
};

/**
 * Handle new WebSocket connection for log streaming
 * @param {WebSocket} ws - WebSocket connection
 * @param {Object} sessionRecord - Database session record
 */
const handleLogStreamConnection = async (ws, sessionRecord) => {
  const sessionId = sessionRecord.session_id;
  const logPath = sessionRecord.log_path;

  try {
    // Update session status
    await sessionRecord.update({
      status: 'active',
      connected_at: new Date(),
    });

    // Build tail command
    const command = ['tail', '-f'];

    // Add initial lines
    if (sessionRecord.follow_lines > 0) {
      command.push('-n', sessionRecord.follow_lines.toString());
    }

    command.push(logPath);

    // Start tail process
    const tailProcess = spawn(command[0], command.slice(1));

    // Track active session
    const sessionData = {
      sessionId,
      ws,
      tailProcess,
      logname: sessionRecord.logname,
      connectedAt: new Date(),
      linesSent: 0,
      clientIP: ws._socket.remoteAddress,
    };

    activeSessions.set(sessionId, sessionData);

    log.websocket.info('WebSocket connected to log stream', {
      session_id: sessionId,
      logname: sessionRecord.logname,
      client_ip: sessionData.clientIP,
    });

    // Send initial status message
    ws.send(
      JSON.stringify({
        type: 'status',
        message: `Connected to ${sessionRecord.logname}`,
        session_id: sessionId,
        timestamp: new Date().toISOString(),
      })
    );

    // Handle tail output
    tailProcess.stdout.on('data', data => {
      if (ws.readyState === WebSocket.OPEN) {
        const lines = data
          .toString()
          .split('\n')
          .filter(line => line.trim());

        for (const line of lines) {
          // Apply grep filter if specified
          if (sessionRecord.grep_pattern) {
            if (!line.includes(sessionRecord.grep_pattern)) {
              continue;
            }
          }

          ws.send(
            JSON.stringify({
              type: 'log_line',
              line,
              timestamp: new Date().toISOString(),
            })
          );

          sessionData.linesSent++;
        }
      }
    });

    // Handle tail stderr
    tailProcess.stderr.on('data', data => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: data.toString(),
            timestamp: new Date().toISOString(),
          })
        );
      }
    });

    // Handle tail process exit
    tailProcess.on('exit', code => {
      log.websocket.info('Tail process exited for log stream session', {
        session_id: sessionId,
        exit_code: code,
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'process_exit',
            code,
            message: 'Log tail process ended',
            timestamp: new Date().toISOString(),
          })
        );
      }
    });

    // Handle WebSocket close
    ws.on('close', async () => {
      log.websocket.info('WebSocket closed for log stream', {
        session_id: sessionId,
        lines_sent: sessionData.linesSent,
      });

      // Kill tail process
      if (tailProcess && !tailProcess.killed) {
        tailProcess.kill();
      }

      // Remove from active sessions
      activeSessions.delete(sessionId);

      // Update database record
      try {
        await sessionRecord.update({
          status: 'closed',
          lines_sent: sessionData.linesSent,
          disconnected_at: new Date(),
        });
      } catch (error) {
        log.database.warn('Failed to update session record on close', {
          session_id: sessionId,
          error: error.message,
        });
      }
    });

    // Handle WebSocket errors
    ws.on('error', error => {
      log.websocket.error('WebSocket error for log stream', {
        session_id: sessionId,
        error: error.message,
      });

      // Kill tail process on error
      if (tailProcess && !tailProcess.killed) {
        tailProcess.kill();
      }

      // Remove from active sessions
      activeSessions.delete(sessionId);
    });

    // Handle incoming messages (for control commands)
    ws.on('message', data => {
      try {
        const message = JSON.parse(data.toString());

        switch (message.type) {
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
            break;
          case 'pause':
            if (tailProcess && !tailProcess.killed) {
              tailProcess.kill('SIGSTOP');
            }
            break;
          case 'resume':
            if (tailProcess && !tailProcess.killed) {
              tailProcess.kill('SIGCONT');
            }
            break;
          default:
            log.websocket.warn('Unknown WebSocket message type', {
              session_id: sessionId,
              message_type: message.type,
            });
        }
      } catch (error) {
        log.websocket.warn('Error processing WebSocket message', {
          session_id: sessionId,
          error: error.message,
        });
      }
    });
  } catch (error) {
    log.websocket.error('Error setting up log stream connection', {
      session_id: sessionId,
      error: error.message,
    });
    ws.close();

    // Update session record on error
    try {
      await sessionRecord.update({
        status: 'error',
        error_message: error.message,
        disconnected_at: new Date(),
      });
    } catch (updateError) {
      log.database.warn('Failed to update session record on error', {
        session_id: sessionId,
        error: updateError.message,
      });
    }
  }
};

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
 *                 status:
 *                   type: string
 *       404:
 *         description: Log file not found
 *       400:
 *         description: Invalid parameters or security violation
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
 * Handle WebSocket upgrade for log streaming
 * @param {Object} request - HTTP request object
 * @param {Object} socket - Network socket
 * @param {Buffer} head - First packet of upgraded stream
 * @param {Object} wss - WebSocket server instance
 */
export const handleLogStreamUpgrade = async (request, socket, head, wss) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const pathParts = url.pathname.split('/');

    if (pathParts.length !== 4 || pathParts[1] !== 'logs' || pathParts[2] !== 'stream') {
      socket.destroy();
      return;
    }

    const [, , , sessionId] = pathParts;

    // Verify session exists in database
    const sessionRecord = await LogStreamSession.findOne({
      where: { session_id: sessionId },
    });

    if (!sessionRecord) {
      log.websocket.warn('Log stream session not found for WebSocket upgrade', {
        session_id: sessionId,
      });
      socket.destroy();
      return;
    }

    // Handle WebSocket upgrade
    wss.handleUpgrade(request, socket, head, ws => {
      log.websocket.debug('WebSocket upgrade request for log stream', {
        session_id: sessionId,
      });
      handleLogStreamConnection(ws, sessionRecord);
    });
  } catch (error) {
    log.websocket.error('Error handling log stream upgrade', {
      error: error.message,
    });
    socket.destroy();
  }
};

/**
 * Get log stream session info
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
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

export default {
  startLogStream,
  listLogStreamSessions,
  stopLogStream,
  getLogStreamInfo,
  handleLogStreamUpgrade,
  handleLogStreamConnection,
  cleanupLogStreamSessions,
};
