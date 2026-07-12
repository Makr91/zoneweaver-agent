/**
 * @fileoverview WebSocket Handler for Zoneweaver Agent
 * @description Handles WebSocket upgrade requests for VNC, terminal, and log streaming
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import WebSocket from 'ws';
import crypto from 'crypto';
import { log } from './Logger.js';
import { verifyTicket } from './WsTicket.js';
import TerminalSessions from '../models/TerminalSessionModel.js';
import ZloginSessions from '../models/ZloginSessionModel.js';
import { handleTerminalConnection } from '../controllers/XtermController.js';
import { handleZloginConnection } from '../controllers/ZloginController.js';
import { handleLogStreamUpgrade } from '../controllers/LogStreamController.js';
import SSHSessions from '../models/SSHSessionModel.js';
import { handleSSHConnection } from '../controllers/SSHTerminalController.js';
import { sessionManager } from '../controllers/VncConsoleController/utils/VncSessionManager.js';
import { connectionTracker } from '../controllers/VncConsoleController/utils/VncConnectionTracker.js';
import { performSmartCleanup } from '../controllers/VncConsoleController/index.js';
import Tasks from '../models/TaskModel.js';
import { taskOutputManager } from './TaskOutputManager.js';

/**
 * Setup VNC WebSocket connection
 */
const setupVncWebSocket = (ws, zoneName, sessionInfo, connTracker, smartCleanup) => {
  log.websocket.info('VNC WebSocket client connected', {
    zone_name: zoneName,
    vnc_port: sessionInfo.port,
  });

  // Generate unique connection ID for tracking
  const connectionId = crypto.randomUUID();

  // Track this connection
  connTracker.addConnection(zoneName, connectionId);

  // Create connection to VNC server
  const backendUrl = `ws://127.0.0.1:${sessionInfo.port}/websockify`;
  const backendWs = new WebSocket(backendUrl, {
    protocol: 'binary',
  });

  backendWs.on('open', () => {
    log.websocket.debug('Connected to VNC server', {
      zone_name: zoneName,
      vnc_port: sessionInfo.port,
      connection_id: connectionId,
    });

    // Forward messages between client and VNC server
    ws.on('message', data => {
      if (backendWs.readyState === WebSocket.OPEN) {
        backendWs.send(data);
      }
    });

    backendWs.on('message', data => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Handle connection cleanup
    const handleConnectionClose = () => {
      const isLastClient = connTracker.removeConnection(zoneName, connectionId);

      log.websocket.debug('VNC client WebSocket closed', {
        zone_name: zoneName,
        connection_id: connectionId,
        is_last_client: isLastClient,
      });

      smartCleanup(zoneName, isLastClient);

      if (backendWs.readyState === WebSocket.OPEN) {
        backendWs.close();
      }
    };

    ws.on('close', handleConnectionClose);

    ws.on('error', err => {
      log.websocket.error('VNC client WebSocket error', {
        zone_name: zoneName,
        connection_id: connectionId,
        error: err.message,
      });
      handleConnectionClose();
    });

    backendWs.on('close', () => {
      log.websocket.debug('VNC server WebSocket closed', {
        zone_name: zoneName,
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    backendWs.on('error', err => {
      log.websocket.error('VNC server WebSocket error', {
        zone_name: zoneName,
        vnc_port: sessionInfo.port,
        error: err.message,
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });
  });

  backendWs.on('error', err => {
    log.websocket.error('Failed to connect to VNC server', {
      zone_name: zoneName,
      vnc_port: sessionInfo.port,
      backend_url: backendUrl,
      error: err.message,
    });

    const isLastClient = connTracker.removeConnection(zoneName, connectionId);
    smartCleanup(zoneName, isLastClient);

    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1002, 'VNC server connection failed');
    }
  });
};

/**
 * Setup VNC connection
 */
const setupVncConnection = (zoneName, request, socket, head, wss) => {
  try {
    // Get session info using static imports
    const sessionInfo = sessionManager.getSessionInfo(zoneName);

    if (!sessionInfo) {
      log.websocket.error('No active VNC session found for zone', {
        zone_name: zoneName,
        pathname: request.url,
      });
      socket.destroy();
      return;
    }

    // Use proper WebSocket server upgrade
    wss.handleUpgrade(request, socket, head, ws => {
      setupVncWebSocket(ws, zoneName, sessionInfo, connectionTracker, performSmartCleanup);
    });
  } catch (error) {
    log.websocket.error('Error setting up VNC connection', {
      zone_name: zoneName,
      error: error.message,
    });
    socket.destroy();
  }
};

/**
 * Handle task output stream WebSocket connection
 * Replays buffered output, then streams live updates
 * @param {WebSocket} ws - WebSocket connection
 * @param {string} taskId - Task UUID
 * @param {string} taskStatus - Current task status
 * @param {Array|null} historicalOutput - Pre-fetched output for completed tasks
 */
const handleTaskStreamConnection = (ws, taskId, taskStatus, historicalOutput) => {
  const replayEntries = historicalOutput || taskOutputManager.getBuffer(taskId);

  // Send buffered/historical output as replay
  for (const entry of replayEntries) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'output',
          task_id: taskId,
          stream: entry.stream,
          data: entry.data,
          timestamp: entry.timestamp,
        })
      );
    }
  }

  // If task is already finished, send status and close
  if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(taskStatus)) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'status',
          task_id: taskId,
          status: taskStatus,
        })
      );
      ws.close();
    }
    return;
  }

  // Subscribe to live output for running tasks
  const unsubscribe = taskOutputManager.subscribe(taskId, entry => {
    if (ws.readyState !== WebSocket.OPEN) {
      unsubscribe();
      return;
    }

    if (entry.stream === 'system' && entry.data === 'finalized') {
      // Task completed — fetch final status from DB
      Tasks.findByPk(taskId, { attributes: ['status'] })
        .then(finalTask => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'status',
                task_id: taskId,
                status: finalTask?.status || 'completed',
              })
            );
            ws.close();
          }
        })
        .catch(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
        });
      return;
    }

    ws.send(
      JSON.stringify({
        type: 'output',
        task_id: taskId,
        stream: entry.stream,
        data: entry.data,
        timestamp: entry.timestamp,
      })
    );
  });

  ws.on('close', () => {
    unsubscribe();
  });

  ws.on('error', err => {
    log.websocket.error('Task stream WebSocket error', {
      task_id: taskId,
      error: err.message,
    });
    unsubscribe();
  });
};

/**
 * Handle terminal WebSocket upgrade
 */
const handleTerminalWsUpgrade = async (sessionId, request, socket, head, wss) => {
  const session = await TerminalSessions.findByPk(sessionId);

  // 'connecting' is accepted — /term/start answers before the PTY spawn
  // finishes, and the connection handler waits for the PTY.
  if (!session || !['active', 'connecting'].includes(session.status)) {
    log.websocket.warn('Terminal WebSocket upgrade failed - session not found or inactive', {
      session_id: sessionId,
      session_status: session?.status,
    });
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, ws => {
    handleTerminalConnection(ws, sessionId);
  });
};

/**
 * Handle zlogin WebSocket upgrade
 */
const handleZloginWsUpgrade = async (sessionId, pathname, request, socket, head, wss) => {
  log.websocket.debug('Zlogin WebSocket upgrade request', {
    session_id: sessionId,
    pathname,
  });

  try {
    const session = await ZloginSessions.findByPk(sessionId);

    if (!session) {
      log.websocket.warn('Zlogin session not found for WebSocket upgrade', {
        session_id: sessionId,
      });
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (session.status !== 'active' && session.status !== 'connecting') {
      log.websocket.warn('Zlogin WebSocket upgrade failed - invalid session status', {
        session_id: sessionId,
        status: session.status,
      });
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    log.websocket.info('Zlogin WebSocket upgrade approved', {
      session_id: sessionId,
      zone_name: session.zone_name,
      status: session.status,
    });

    wss.handleUpgrade(request, socket, head, ws => {
      handleZloginConnection(ws, sessionId);
    });
  } catch (error) {
    log.websocket.error('Error during zlogin WebSocket upgrade', {
      session_id: sessionId,
      error: error.message,
      stack: error.stack,
    });
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
  }
};

/**
 * Handle SSH terminal WebSocket upgrade
 */
const handleSSHWsUpgrade = async (sessionId, request, socket, head, wss) => {
  log.websocket.debug('SSH terminal WebSocket upgrade request', {
    session_id: sessionId,
  });

  try {
    const session = await SSHSessions.findByPk(sessionId);

    if (!session) {
      log.websocket.warn('SSH session not found for WebSocket upgrade', {
        session_id: sessionId,
      });
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (session.status !== 'connecting' && session.status !== 'active') {
      log.websocket.warn('SSH WebSocket upgrade failed - invalid session status', {
        session_id: sessionId,
        status: session.status,
      });
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    log.websocket.info('SSH WebSocket upgrade approved', {
      session_id: sessionId,
      zone_name: session.zone_name,
      status: session.status,
    });

    wss.handleUpgrade(request, socket, head, ws => {
      handleSSHConnection(ws, sessionId);
    });
  } catch (error) {
    log.websocket.error('Error during SSH WebSocket upgrade', {
      session_id: sessionId,
      error: error.message,
      stack: error.stack,
    });
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
  }
};

/**
 * Handle task output stream WebSocket upgrade
 */
const handleTaskStreamUpgrade = async (taskId, request, socket, head, wss) => {
  log.websocket.debug('Task output stream WebSocket upgrade request', {
    task_id: taskId,
  });

  const task = await Tasks.findByPk(taskId);
  if (!task) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // For completed tasks, fetch output from DB before upgrade
  let historicalOutput = null;
  if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(task.status)) {
    historicalOutput = await taskOutputManager.getOutput(taskId);
  }

  wss.handleUpgrade(request, socket, head, ws => {
    handleTaskStreamConnection(ws, taskId, task.status, historicalOutput);
  });
};

/**
 * WebSocket upgrade handler
 * @description Routes WebSocket upgrade requests to appropriate handlers
 */
export const handleWebSocketUpgrade = async (request, socket, head, wss) => {
  try {
    if (!wss) {
      log.websocket.error('WebSocket server instance is undefined', {
        pathname: request?.url,
        wss_type: typeof wss,
      });
      socket.destroy();
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host}`);
    log.websocket.debug('WebSocket upgrade request', {
      pathname: url.pathname,
      host: request.headers.host,
    });

    // Every upgrade requires a short-lived ticket minted by GET /ws-ticket —
    // verifyApiKey is Express middleware and never runs on upgrade requests
    if (!verifyTicket(url.searchParams.get('ticket'))) {
      log.websocket.warn('WebSocket upgrade rejected - missing or invalid ticket', {
        pathname: url.pathname,
      });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const termMatch = url.pathname.match(/\/term\/(?<sessionId>[a-fA-F0-9-]+)/);
    if (termMatch) {
      await handleTerminalWsUpgrade(termMatch.groups.sessionId, request, socket, head, wss);
      return;
    }

    const zloginMatch = url.pathname.match(/\/zlogin\/(?<sessionId>[a-fA-F0-9-]+)/);
    if (zloginMatch) {
      await handleZloginWsUpgrade(
        zloginMatch.groups.sessionId,
        url.pathname,
        request,
        socket,
        head,
        wss
      );
      return;
    }

    const sshMatch = url.pathname.match(/\/ssh\/(?<sessionId>[a-fA-F0-9-]+)/);
    if (sshMatch) {
      await handleSSHWsUpgrade(sshMatch.groups.sessionId, request, socket, head, wss);
      return;
    }

    const logStreamMatch = url.pathname.match(/\/logs\/stream\/(?<sessionId>[a-fA-F0-9-]+)/);
    if (logStreamMatch) {
      log.websocket.debug('Log stream WebSocket upgrade request', {
        session_id: logStreamMatch.groups.sessionId,
      });
      await handleLogStreamUpgrade(request, socket, head, wss);
      return;
    }

    const taskStreamMatch = url.pathname.match(/\/tasks\/(?<taskId>[a-fA-F0-9-]+)\/stream/);
    if (taskStreamMatch) {
      await handleTaskStreamUpgrade(taskStreamMatch.groups.taskId, request, socket, head, wss);
      return;
    }

    // Agent API v1 (O1): `machines` is the canonical resource noun — the VNC
    // websockify upgrade is served at /machines/{name}/vnc/websockify only.
    const vncMatch = url.pathname.match(/\/machines\/(?<zoneName>[^/]+)\/vnc\/websockify/);
    if (vncMatch) {
      const zoneName = decodeURIComponent(vncMatch.groups.zoneName);
      log.websocket.debug('Zone-specific VNC WebSocket request', {
        zone_name: zoneName,
      });
      setupVncConnection(zoneName, request, socket, head, wss);
      return;
    }

    log.websocket.error('Unrecognized WebSocket path', {
      pathname: url.pathname,
    });
    socket.destroy();
  } catch (error) {
    log.websocket.error('WebSocket upgrade error', {
      error: error.message,
      stack: error.stack,
      pathname: request?.url,
    });
    socket.destroy();
  }
};
