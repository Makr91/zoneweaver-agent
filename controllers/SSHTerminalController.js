/**
 * @fileoverview SSH Terminal Controller for Zoneweaver Agent
 * @description Manages interactive SSH terminal sessions to zones via WebSocket.
 *              Uses ssh2 library for SSH connections piped through WebSocket to xterm.js frontend.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { Client } from 'ssh2';
import { readFileSync } from 'fs';
import SSHSessions from '../models/SSHSessionModel.js';
import Zones from '../models/ZoneModel.js';
import { log } from '../lib/Logger.js';
import {
  extractCredentialsFromSettings,
  extractControlIP,
} from '../lib/ProvisionerConfigBuilder.js';
import config from '../config/ConfigLoader.js';

/**
 * Active SSH connections: sessionId → { conn: ssh2.Client, stream: ssh2.Channel }
 */
const activeConnections = new Map();

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
const buildSSHConnectionOptions = (host, port, username, credentials, provisioningBasePath) => {
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
const parseZoneConfig = zone => {
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
const getProvisioningBasePath = zoneName => `/rpool/zones/${zoneName}/provisioning`;

/**
 * Close an active SSH connection and remove from tracking
 * @param {string} sessionId - Session ID to clean up
 */
const cleanupConnection = sessionId => {
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
const setupSSHPiping = (ws, session, stream) => {
  const sessionId = session.id;

  // Pipe SSH stdout to WebSocket and update session buffer
  stream.on('data', async data => {
    const text = data.toString();
    if (ws.readyState === ws.OPEN) {
      ws.send(text);
    }

    try {
      const currentBuffer = session.session_buffer || '';
      const newBuffer = (currentBuffer + text).split('\n').slice(-1000).join('\n');
      await session.update({ session_buffer: newBuffer, last_activity: new Date() });
    } catch (error) {
      log.websocket.error('Error updating SSH session buffer', {
        session_id: sessionId,
        error: error.message,
      });
    }
  });

  // Pipe SSH stderr to WebSocket
  stream.stderr.on('data', data => {
    const text = data.toString();
    if (ws.readyState === ws.OPEN) {
      ws.send(text);
    }
  });

  // Handle WebSocket input → SSH
  ws.on('message', async data => {
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
    try {
      await session.update({ last_activity: new Date() });
    } catch (error) {
      log.websocket.error('Error updating SSH activity timestamp', {
        session_id: sessionId,
        error: error.message,
      });
    }
  });

  // Handle WebSocket close → close SSH
  ws.on('close', (code, reason) => {
    log.websocket.info('SSH WebSocket closed', {
      session_id: sessionId,
      zone_name: session.zone_name,
      code,
      reason: reason || 'none',
    });
    cleanupConnection(sessionId);
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
  });

  // Update session access time
  session.update({ last_accessed: new Date(), last_activity: new Date() });
};

/**
 * @swagger
 * tags:
 *   name: SSH Terminal
 *   description: Interactive SSH terminal sessions to machines
 * /machines/{machineName}/ssh/start:
 *   post:
 *     summary: Start an SSH terminal session
 *     description: Creates an SSH terminal session for the specified machine (zone).
 *                  Returns session ID for WebSocket connection at /ssh/{sessionId}.
 *     tags: [SSH Terminal]
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
 *         description: SSH session created successfully.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SSHSession'
 *       400:
 *         description: Machine not running or SSH credentials not configured.
 *       404:
 *         description: Machine not found.
 *       500:
 *         description: Failed to start SSH session.
 */
export const startSSHSession = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;
    log.websocket.info('Starting SSH terminal session', { zone_name: zoneName });

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    if (zone.status !== 'running') {
      return res.status(400).json({ error: 'Zone is not running' });
    }

    const zoneConfig = parseZoneConfig(zone);

    // Extract SSH credentials from zone settings
    const credentials = zoneConfig.settings
      ? extractCredentialsFromSettings(zoneConfig.settings)
      : {};

    if (!credentials.username) {
      return res.status(400).json({
        error: 'SSH credentials not configured. Set settings.vagrant_user in zone configuration.',
      });
    }

    // Extract zone IP address from networks
    const sshHost = extractControlIP(zoneConfig.networks);
    if (!sshHost) {
      return res.status(400).json({
        error: 'Zone IP address not found. Set is_control: true on a network with an address.',
      });
    }

    // Each call creates an independent session — multiple users can SSH to the same zone
    // Create new session
    const session = await SSHSessions.create({
      zone_name: zoneName,
      status: 'connecting',
      ssh_host: sshHost,
      ssh_port: 22,
      ssh_username: credentials.username,
    });

    log.websocket.info('SSH session created', {
      session_id: session.id,
      zone_name: zoneName,
      ssh_host: sshHost,
      ssh_username: credentials.username,
    });

    return res.json(session);
  } catch (error) {
    log.websocket.error('Error starting SSH session', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to start SSH session' });
  }
};

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

/**
 * @swagger
 * /ssh/sessions/{sessionId}:
 *   get:
 *     summary: Get SSH session information
 *     description: Retrieves information about a specific SSH terminal session.
 *     tags: [SSH Terminal]
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
 *               $ref: '#/components/schemas/SSHSession'
 *       404:
 *         description: Session not found.
 */
export const getSSHSessionInfo = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await SSHSessions.findByPk(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'SSH session not found' });
    }

    return res.json(session);
  } catch (error) {
    log.websocket.error('Error getting SSH session info', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to get SSH session info' });
  }
};

/**
 * @swagger
 * /ssh/sessions/{sessionId}/stop:
 *   delete:
 *     summary: Stop an SSH session
 *     description: Terminates a specific SSH terminal session and closes the SSH connection.
 *     tags: [SSH Terminal]
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
export const stopSSHSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await SSHSessions.findByPk(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'SSH session not found' });
    }

    // Close SSH connection
    cleanupConnection(sessionId);

    // Update DB session
    await session.update({ status: 'closed' });

    log.websocket.info('SSH session stopped', {
      session_id: sessionId,
      zone_name: session.zone_name,
    });

    return res.json({ success: true, message: 'SSH session stopped.' });
  } catch (error) {
    log.websocket.error('Error stopping SSH session', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to stop SSH session' });
  }
};

/**
 * @swagger
 * /ssh/sessions:
 *   get:
 *     summary: List all SSH sessions
 *     description: Retrieves a list of all SSH terminal sessions.
 *     tags: [SSH Terminal]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: A list of SSH sessions.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/SSHSession'
 */
export const listSSHSessions = async (req, res) => {
  void req;
  try {
    const sessions = await SSHSessions.findAll({
      order: [['created_at', 'DESC']],
    });
    res.json(sessions);
  } catch (error) {
    log.websocket.error('Error listing SSH sessions', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to list SSH sessions' });
  }
};

/**
 * Get cleanup task configuration for CleanupService
 * @returns {Object} Cleanup task config
 */
export const getSSHCleanupTask = () => ({
  name: 'ssh_session_cleanup',
  description: 'Clean up closed SSH terminal sessions',
  model: SSHSessions,
  where: {
    status: 'closed',
  },
});

/**
 * Clean up stale SSH sessions on startup
 * All sessions are stale after a server restart since SSH connections don't survive.
 */
export const startSSHSessionCleanup = async () => {
  try {
    const staleSessions = await SSHSessions.findAll({
      where: { status: ['connecting', 'active'] },
    });

    const results = await Promise.all(
      staleSessions.map(session => session.update({ status: 'closed' }))
    );

    log.websocket.info('SSH session startup cleanup completed', {
      cleaned_count: results.length,
    });
  } catch (error) {
    log.websocket.error('SSH session startup cleanup failed', {
      error: error.message,
    });
  }
};
