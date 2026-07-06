/**
 * @fileoverview Log stream WebSocket handling — tail-process connection
 * lifecycle and the WS upgrade entry point.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import LogStreamSession from '../../models/LogStreamSessionModel.js';
import { log } from '../../lib/Logger.js';
import { activeSessions } from './utils/StreamHelpers.js';

/**
 * Handle new WebSocket connection for log streaming
 * @param {WebSocket} ws - WebSocket connection
 * @param {Object} sessionRecord - Database session record
 */
export const handleLogStreamConnection = async (ws, sessionRecord) => {
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
