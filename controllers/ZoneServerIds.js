import Zones from '../models/ZoneModel.js';
import config from '../config/ConfigLoader.js';
import { log } from '../lib/Logger.js';

/**
 * @fileoverview Zone Server ID Management Controller
 * @description Provides endpoints for discovering available server IDs for zone creation
 */

/**
 * Generate the next available server_id
 * Finds the highest existing server_id and increments by 1
 * @returns {Promise<string>} Next available server_id (zero-padded to 4 digits minimum)
 */
const generateNextServerId = async () => {
  const zonesConfig = config.getZones();
  const startingId = zonesConfig.server_id_start || 1;

  const highest = await Zones.findOne({
    where: { server_id: { [Zones.sequelize.Sequelize.Op.ne]: null } },
    order: [[Zones.sequelize.literal('CAST(server_id AS INTEGER)'), 'DESC']],
    attributes: ['server_id'],
  });

  const nextId = highest ? Math.max(parseInt(highest.server_id, 10) + 1, startingId) : startingId;

  return String(nextId).padStart(4, '0');
};

/**
 * @swagger
 * /machines/ids:
 *   get:
 *     summary: Get server ID usage information
 *     description: |
 *       Returns information about used server IDs, constraints, and next available ID.
 *       Used by clients to discover available server IDs before creating machines.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Server ID information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 used:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       server_id:
 *                         type: string
 *                         example: "0001"
 *                       machine_name:
 *                         type: string
 *                         example: "0001--web.example.com"
 *                       status:
 *                         type: string
 *                         example: "running"
 *                 constraints:
 *                   type: object
 *                   properties:
 *                     format:
 *                       type: string
 *                       example: "numeric"
 *                     min_length:
 *                       type: integer
 *                       example: 4
 *                     max_length:
 *                       type: integer
 *                       example: 8
 *                     min_value:
 *                       type: integer
 *                       example: 1
 *                     max_value:
 *                       type: integer
 *                       example: 99999999
 *                 next_available:
 *                   type: string
 *                   example: "0002"
 *                 total_used:
 *                   type: integer
 *                   example: 2
 *       500:
 *         description: Server error
 */
export const getServerIds = async (req, res) => {
  try {
    // Get all zones with server_id
    const zones = await Zones.findAll({
      where: { server_id: { [Zones.sequelize.Sequelize.Op.ne]: null } },
      attributes: ['server_id', 'name', 'status'],
      order: [['server_id', 'ASC']],
    });

    const used = zones.map(zone => ({
      server_id: zone.server_id,
      machine_name: zone.name,
      status: zone.status,
    }));

    const nextAvailable = await generateNextServerId();

    return res.json({
      used,
      constraints: {
        format: 'numeric',
        min_length: 4,
        max_length: 8,
        min_value: 1,
        max_value: 99999999,
      },
      next_available: nextAvailable,
      total_used: used.length,
    });
  } catch (error) {
    log.api_requests.error('Failed to retrieve server ID information', {
      error: error.message,
      user: req.entity?.name,
    });
    return res.status(500).json({ error: 'Failed to retrieve server ID information' });
  }
};

/**
 * @swagger
 * /machines/ids/next:
 *   get:
 *     summary: Get next available server ID
 *     description: |
 *       Returns the next available server ID for machine creation.
 *       Useful for automation scripts that need to quickly allocate a server ID.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Next available server ID
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 server_id:
 *                   type: string
 *                   example: "0002"
 *       500:
 *         description: Server error
 */
export const getNextServerId = async (req, res) => {
  try {
    const serverId = await generateNextServerId();

    return res.json({ server_id: serverId });
  } catch (error) {
    log.api_requests.error('Failed to generate next server ID', {
      error: error.message,
      user: req.entity?.name,
    });
    return res.status(500).json({ error: 'Failed to generate next server ID' });
  }
};
