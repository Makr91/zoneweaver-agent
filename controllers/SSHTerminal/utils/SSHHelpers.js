/**
 * @fileoverview SSH Terminal Helpers for Zoneweaver Agent
 * @description Shared SSH connection state, connection option building, and
 *              WebSocket piping helpers for SSH terminal sessions.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { readFileSync } from 'fs';
import { log } from '../../../lib/Logger.js';
import config from '../../../config/ConfigLoader.js';
import { createSessionBufferWriter } from '../../../lib/SessionBuffer.js';

/**
 * Active SSH connections: sessionId → { conn: ssh2.Client, stream: ssh2.Channel }
 */
export const activeConnections = new Map();

/**
 * Get SSH key path from config or default
 * @returns {string} Path to SSH private key
 */
const getSSHKeyPath = () => {
  const provConfig = config.get('provisioning') || {};
  const sshConfig = provConfig.ssh || {};
  return sshConfig.key_path || '/etc/zoneweaver-agent/ssh/provision_key';
};

/**
 * Build ssh2 connection options for interactive terminal
 * @param {string} host - SSH target host
 * @param {number} port - SSH target port
 * @param {string} username - SSH username
 * @param {Object} credentials - { password, ssh_key_path }
 * @param {string} provisioningBasePath - Base path for resolving relative key paths
 * @returns {Object} ssh2 connection options
 */
export const buildSSHConnectionOptions = (
  host,
  port,
  username,
  credentials,
  provisioningBasePath
) => {
  const options = {
    host,
    port,
    username,
    readyTimeout: 15000,
  };

  if (credentials.ssh_key_path) {
    let keyPath = credentials.ssh_key_path;
    if (provisioningBasePath && !keyPath.startsWith('/')) {
      keyPath = `${provisioningBasePath}/${keyPath}`;
    }
    try {
      options.privateKey = readFileSync(keyPath);
    } catch (err) {
      throw new Error(`Failed to read SSH key at ${keyPath}: ${err.message}`);
    }
    return options;
  }

  if (credentials.password) {
    options.password = credentials.password;
    return options;
  }

  try {
    options.privateKey = readFileSync(getSSHKeyPath());
  } catch (err) {
    throw new Error(`Failed to read default SSH key: ${err.message}`);
  }
  return options;
};

/**
 * Parse zone configuration JSON
 * @param {Object} zone - Zone database record
 * @returns {Object} Parsed zone configuration
 */
export const parseZoneConfig = zone => {
  let zoneConfig = zone.configuration;
  if (typeof zoneConfig === 'string') {
    try {
      zoneConfig = JSON.parse(zoneConfig);
    } catch {
      zoneConfig = {};
    }
  }
  return zoneConfig || {};
};

/**
 * Get the provisioning dataset base path for a zone
 * @param {string} zoneName - Zone name
 * @returns {string} Provisioning base path
 */
export const getProvisioningBasePath = zoneName => `/rpool/zones/${zoneName}/provisioning`;

/**
 * Close an active SSH connection and remove from tracking
 * @param {string} sessionId - Session ID to clean up
 */
export const cleanupConnection = sessionId => {
  const active = activeConnections.get(sessionId);
  if (active) {
    try {
      active.conn.end();
    } catch {
      // Connection may already be closed
    }
    activeConnections.delete(sessionId);
  }
};

/**
 * Wire SSH stream ↔ WebSocket bidirectional data piping
 * @param {import('ws').WebSocket} ws - WebSocket connection
 * @param {Object} session - SSHSession database record
 * @param {import('ssh2').Channel} stream - SSH shell channel
 */
export const setupSSHPiping = (ws, session, stream) => {
  const sessionId = session.id;
  const bufferWriter = createSessionBufferWriter(session);

  // Pipe SSH stdout to WebSocket and buffer it (debounced flush)
  stream.on('data', data => {
    const text = data.toString();
    if (ws.readyState === ws.OPEN) {
      ws.send(text);
    }
    bufferWriter.append(text);
  });

  // Pipe SSH stderr to WebSocket
  stream.stderr.on('data', data => {
    const text = data.toString();
    if (ws.readyState === ws.OPEN) {
      ws.send(text);
    }
  });

  // Handle WebSocket input → SSH
  ws.on('message', data => {
    const text = data.toString();

    // Check for JSON control messages (resize)
    try {
      const msg = JSON.parse(text);
      if (msg.type === 'resize' && msg.cols && msg.rows) {
        stream.setWindow(msg.rows, msg.cols, 0, 0);
        return;
      }
    } catch {
      // Not JSON — raw terminal input
    }

    stream.write(text);
    bufferWriter.touch();
  });

  // Handle WebSocket close → close SSH
  ws.on('close', async (code, reason) => {
    log.websocket.info('SSH WebSocket closed', {
      session_id: sessionId,
      zone_name: session.zone_name,
      code,
      reason: reason || 'none',
    });
    cleanupConnection(sessionId);
    await bufferWriter.close();
    session.update({ status: 'closed' });
  });

  // Handle WebSocket errors
  ws.on('error', error => {
    log.websocket.error('SSH WebSocket error', {
      session_id: sessionId,
      zone_name: session.zone_name,
      error: error.message,
    });
    cleanupConnection(sessionId);
    bufferWriter.close();
  });

  // Update session access time
  session.update({ last_accessed: new Date(), last_activity: new Date() });
};
