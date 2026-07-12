import { getPtyProcess } from './TerminalSessionController.js';
import TerminalSessions from '../models/TerminalSessionModel.js';
import { log } from '../lib/Logger.js';
import { createSessionBufferWriter } from '../lib/SessionBuffer.js';

/**
 * @fileoverview Xterm Terminal WebSocket handler for Zoneweaver Agent
 * @description Handles the WebSocket connection for an active terminal session.
 */

/**
 * Sets up the terminal connection between WebSocket and PTY
 * @param {import('ws').WebSocket} ws - The WebSocket connection
 * @param {string} sessionId - The session ID
 * @param {import('../models/TerminalSessionModel.js').default} session - The session record
 * @param {import('node-pty').IPty} ptyProcess - The PTY process
 */
const setupTerminalConnection = async (ws, sessionId, session, ptyProcess) => {
  // Send existing buffer on connection (for reconnection context)
  if (session.session_buffer) {
    const bufferLines = session.session_buffer.split('\n');
    const contextLines = bufferLines.slice(-50); // Send last 50 lines as context
    if (contextLines.length > 0) {
      ws.send('\r\n=== Session Reconnected - Last 50 lines ===\r\n');
      ws.send(contextLines.join('\r\n'));
      ws.send('\r\n=== Live Terminal ===\r\n');
    }
  }

  // Update last accessed timestamp
  await session.update({
    last_accessed: new Date(),
    last_activity: new Date(),
  });

  const bufferWriter = createSessionBufferWriter(session);

  // Pipe data from PTY to WebSocket and buffer it (debounced flush)
  const onPtyData = data => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
    bufferWriter.append(data);
  };

  ptyProcess.on('data', onPtyData);

  // Pipe data from WebSocket to PTY and update activity
  ws.on('message', command => {
    const text = command.toString();

    // NUL-prefixed control message from the UI (PTY resize). Anything that doesn't
    // parse falls through to the shell, so typed/pasted input is never swallowed.
    if (text.charCodeAt(0) === 0) {
      try {
        const ctrl = JSON.parse(text.slice(1));
        if (ctrl.type === 'resize') {
          const cols = parseInt(ctrl.cols);
          const rows = parseInt(ctrl.rows);
          if (cols > 0 && cols <= 1000 && rows > 0 && rows <= 1000) {
            ptyProcess.resize(cols, rows);
            return;
          }
        }
      } catch {
        /* not a control message — fall through and write it to the PTY */
      }
    }

    ptyProcess.write(text);
    bufferWriter.touch();
  });

  // Handle WebSocket close
  ws.on('close', () => {
    log.websocket.info('WebSocket closed for terminal session', {
      session_id: sessionId,
    });
    ptyProcess.removeListener('data', onPtyData);
    bufferWriter.close();
  });

  // Handle WebSocket errors
  ws.on('error', error => {
    log.websocket.error('WebSocket error for terminal session', {
      session_id: sessionId,
      error: error.message,
      stack: error.stack,
    });
  });
};

/**
 * Handles a new WebSocket connection for an existing terminal session.
 * @param {import('ws').WebSocket} ws - The WebSocket connection object.
 * @param {string} sessionId - The ID of the terminal session.
 */
export const handleTerminalConnection = async (ws, sessionId) => {
  // Get session from database first
  const session = await TerminalSessions.findByPk(sessionId);
  if (!session) {
    ws.send('Terminal session not found in database.');
    ws.close();
    return;
  }

  log.websocket.info('WebSocket connected to terminal session', {
    session_id: sessionId,
    status: session.status,
  });

  // Handle sessions that are still connecting (PTY not ready yet)
  if (session.status === 'connecting') {
    ws.send('\r\n🔄 Terminal starting, please wait...\r\n');

    // Wait for PTY to be ready (poll every 100ms for up to 10 seconds)
    let attempts = 0;
    const maxAttempts = 100; // 10 seconds max wait

    const waitForPty = async () => {
      attempts++;
      const ptyProcess = getPtyProcess(sessionId);

      if (ptyProcess) {
        // PTY is ready, proceed with normal connection
        ws.send('\r\n✅ Terminal ready!\r\n');
        setupTerminalConnection(ws, sessionId, session, ptyProcess);
        return;
      }

      // Check if session failed or timed out
      const updatedSession = await TerminalSessions.findByPk(sessionId);
      if (updatedSession.status === 'failed') {
        ws.send('\r\n❌ Terminal failed to start.\r\n');
        ws.close();
        return;
      }

      if (attempts >= maxAttempts) {
        ws.send('\r\n⏱️ Terminal startup timed out.\r\n');
        ws.close();
        return;
      }

      // Continue waiting
      setTimeout(waitForPty, 100);
    };

    waitForPty();
    return;
  }

  // Session is active, check if PTY exists
  const ptyProcess = getPtyProcess(sessionId);
  if (!ptyProcess) {
    ws.send('Terminal process not found.');
    ws.close();
    return;
  }

  setupTerminalConnection(ws, sessionId, session, ptyProcess);
};
