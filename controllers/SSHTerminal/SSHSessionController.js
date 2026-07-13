/**
 * @fileoverview SSH Terminal Session Controller for Zoneweaver Agent
 * @description REST lifecycle handlers for SSH terminal sessions (start, info, stop,
 *              list, cleanup).
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import SSHSessions from '../../models/SSHSessionModel.js';
import Zones from '../../models/ZoneModel.js';
import { log } from '../../lib/Logger.js';
import {
  extractCredentialsFromSettings,
  extractControlIP,
} from '../../lib/ProvisionerConfigBuilder.js';
import { parseZoneConfig, cleanupConnection } from './utils/SSHHelpers.js';

/**
 * @swagger
 * tags:
 *   name: SSH Terminal
 *   description: Interactive SSH terminal sessions to machines
 * /machines/{machineName}/ssh/start:
 *   post:
 *     summary: Start an SSH terminal session
 *     description: |
 *       Creates an SSH terminal session for the machine. Answer carries the session id
 *       for the `/ssh/{sessionId}` WebSocket.
 *
 *       A guest can hold SEVERAL addresses (multi-homed, or a floating/secondary IP), and
 *       the agent cannot tell which one is routable from here — so it does not guess past
 *       the first. The answer always lists every candidate in `ip_candidates` (guest-agent
 *       live addresses first, then the document's control IP) and reports which one it
 *       used in `ip_index`. If that one is unreachable, retry with the next index — this
 *       is how a UI offers "try the next address".
 *     tags: [SSH Terminal]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ip_index:
 *                 type: integer
 *                 default: 0
 *                 description: Which of `ip_candidates` to connect to (0-based). Out of range answers 400 WITH the candidate list.
 *     responses:
 *       200:
 *         description: SSH session created successfully.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SSHSession'
 *                 - type: object
 *                   properties:
 *                     ip_candidates:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["172.17.205.146", "172.17.6.43"]
 *                     ip_index:
 *                       type: integer
 *                       example: 0
 *       400:
 *         description: Machine not running, no credentials, no reachable address, or ip_index out of range (the body then carries ip_candidates).
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

    // SSH target ladder (the Go agent's shape, bhyve rungs): the guest agent's
    // LIVE addresses first — they survive DHCP renewals and stale documents
    // (discovery refreshes guest_info every tick) — then the document's
    // control IP. A multi-homed guest offers several and NOTHING here can tell
    // which is routable from this host, so the caller picks by index and the
    // whole list always rides the answer.
    const liveIPs =
      zoneConfig.guest_info?.agent_responding && Array.isArray(zoneConfig.guest_info.ips)
        ? zoneConfig.guest_info.ips
        : [];
    const controlIP = extractControlIP(zoneConfig.networks);
    const candidates = [...liveIPs];
    if (controlIP && !candidates.includes(controlIP)) {
      candidates.push(controlIP);
    }

    if (candidates.length === 0) {
      return res.status(400).json({
        error:
          'Zone IP address not found. No live guest-agent address; set is_control: true on a network with an address.',
      });
    }

    const requested = req.body?.ip_index;
    const index = requested === undefined ? 0 : parseInt(requested, 10);
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
      return res.status(400).json({
        error: `ip_index ${requested} is out of range — this machine has ${candidates.length} candidate address(es)`,
        ip_candidates: candidates,
      });
    }
    const sshHost = candidates[index];

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
      ip_index: index,
      ip_candidates: candidates,
      ssh_username: credentials.username,
    });

    return res.json({
      ...session.toJSON(),
      ip_candidates: candidates,
      ip_index: index,
    });
  } catch (error) {
    log.websocket.error('Error starting SSH session', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to start SSH session' });
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
