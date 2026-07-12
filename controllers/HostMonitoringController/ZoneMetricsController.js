/**
 * @fileoverview Zone Metrics Controller for Host Monitoring
 * @description Serves the per-zone CPU/memory/VFS-I/O time series collected by
 * SystemMetricsCollector (zonestat + memory_cap + zone_vfs).
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { Op } from 'sequelize';
import ZoneMetrics from '../../models/ZoneMetricsModel.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /monitoring/zones/usage:
 *   get:
 *     summary: Get per-zone usage metrics
 *     description: |
 *       Per-zone CPU/memory/VFS-I/O time series, one row per zone per
 *       system-metrics tick. Filter to one machine with `zone`; `since` turns
 *       the answer into a series for graphs, without it the latest rows come
 *       first. rss_bytes is REAL guest memory for running bhyve zones
 *       (bhyvectl Resident memory) and memory_cap rss otherwise. Platform
 *       caveat: the I/O figures are FILESYSTEM ops (zvol block traffic is not
 *       per-zone-attributable on this platform).
 *     tags: [Host Monitoring]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: zone
 *         schema:
 *           type: string
 *         description: Filter by zone (machine) name
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Return samples after this timestamp
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 200
 *         description: Maximum rows (1-1000)
 *     responses:
 *       200:
 *         description: Per-zone usage samples (newest first)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 usage:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ZoneMetrics'
 *                 totalCount:
 *                   type: integer
 *                 returnedCount:
 *                   type: integer
 *       500:
 *         description: Failed to get zone metrics
 */
export const getZoneUsageMetrics = async (req, res) => {
  try {
    const { zone, since } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 1000);

    const where = {};
    if (zone) {
      where.zone_name = zone;
    }
    if (since) {
      where.scan_timestamp = { [Op.gt]: new Date(since) };
    }

    const { count, rows } = await ZoneMetrics.findAndCountAll({
      where,
      order: [
        ['scan_timestamp', 'DESC'],
        ['zone_name', 'ASC'],
      ],
      limit,
    });

    return res.json({
      usage: rows,
      totalCount: count,
      returnedCount: rows.length,
    });
  } catch (error) {
    log.api.error('Error getting zone usage metrics', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get zone metrics',
      details: error.message,
    });
  }
};
