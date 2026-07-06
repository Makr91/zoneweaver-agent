/**
 * @fileoverview SSH Terminal Socket Controller for Zoneweaver Agent
 * @description Handles the WebSocket connection for interactive SSH terminal sessions,
 *              establishing the SSH connection and shell.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { Client } from 'ssh2';
import SSHSessions from '../../models/SSHSessionModel.js';
import Zones from '../../models/ZoneModel.js';
import { log } from '../../lib/Logger.js';
import { extractCredentialsFromSettings } from '../../lib/ProvisionerConfigBuilder.js';
import {
  activeConnections,
  buildSSHConnectionOptions,
  parseZoneConfig,
  getProvisioningBasePath,
  setupSSHPiping,
} from './utils/SSHHelpers.js';

/**
 * Handle WebSocket connection for an SSH terminal session
 * Establishes SSH connection, opens interactive shell, pipes data bidirectionally.
 * @param {import('ws').WebSocket} ws - WebSocket connection
 * @param {string} sessionId - SSH session UUID
 */
export const handleSSHConnection = async (ws, sessionId) => {
  try {
    const session = await SSHSessions.findByPk(sessionId);
    if (!session) {
      ws.send('SSH session not found.\r\n');
      ws.close();
      return;
    }

    const { zone_name, ssh_host, ssh_port, ssh_username } = session;

    // Get zone to extract credentials
    const zone = await Zones.findOne({ where: { name: zone_name } });
    if (!zone) {
      ws.send('Zone not found.\r\n');
      ws.close();
      await session.update({ status: 'failed' });
      return;
    }

    const zoneConfig = parseZoneConfig(zone);
    const credentials = zoneConfig.settings
      ? extractCredentialsFromSettings(zoneConfig.settings)
      : {};

    const provisioningBasePath = getProvisioningBasePath(zone_name);

    let connOptions;
    try {
      connOptions = buildSSHConnectionOptions(
        ssh_host,
        ssh_port,
        ssh_username,
        credentials,
        provisioningBasePath
      );
    } catch (err) {
      ws.send(`SSH connection error: ${err.message}\r\n`);
      ws.close();
      await session.update({ status: 'failed' });
      return;
    }

    ws.send('Connecting to SSH...\r\n');

    const conn = new Client();

    conn.on('ready', () => {
      log.websocket.info('SSH connection established', {
        session_id: sessionId,
        zone_name,
        ssh_host,
      });

      conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, async (err, stream) => {
        if (err) {
          log.websocket.error('Failed to open SSH shell', {
            session_id: sessionId,
            error: err.message,
          });
          ws.send(`Failed to open shell: ${err.message}\r\n`);
          ws.close();
          conn.end();
          return;
        }

        // Store active connection
        activeConnections.set(sessionId, { conn, stream });

        // Update session status
        await session.update({ status: 'active', last_activity: new Date() });

        // Wire up bidirectional piping
        setupSSHPiping(ws, session, stream);

        // Handle SSH stream close (remote side closed)
        stream.on('close', () => {
          log.websocket.info('SSH stream closed by remote', {
            session_id: sessionId,
            zone_name,
          });
          activeConnections.delete(sessionId);
          session.update({ status: 'closed' });
          if (ws.readyState === ws.OPEN) {
            ws.send('\r\nSSH connection closed.\r\n');
            ws.close();
          }
        });
      });
    });

    conn.on('error', err => {
      log.websocket.error('SSH connection error', {
        session_id: sessionId,
        zone_name,
        error: err.message,
      });
      activeConnections.delete(sessionId);
      session.update({ status: 'failed' });
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\nSSH connection error: ${err.message}\r\n`);
        ws.close();
      }
    });

    conn.on('close', () => {
      log.websocket.debug('SSH connection closed', {
        session_id: sessionId,
        zone_name,
      });
      activeConnections.delete(sessionId);
    });

    conn.connect(connOptions);
  } catch (error) {
    log.websocket.error('Error handling SSH connection', {
      session_id: sessionId,
      error: error.message,
      stack: error.stack,
    });
    try {
      ws.send(`Error: ${error.message}\r\n`);
      ws.close();
    } catch {
      // Ignore WebSocket send/close errors during error handling
    }
  }
};
