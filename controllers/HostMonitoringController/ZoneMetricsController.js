/**
 * @fileoverview Zone Metrics Controller for Host Monitoring
 * @description Serves the per-machine CPU/memory time series (SystemMetricsCollector)
 * and the per-machine, per-ZVOL disk I/O series (ZvolIoCollector's DTrace consumer).
 * Disk I/O is deliberately a separate surface: a machine's volumes can live on
 * different pools, so the useful unit is the device, not the machine.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { Op } from 'sequelize';
import ZoneMetrics from '../../models/ZoneMetricsModel.js';
import ZvolIoStats from '../../models/ZvolIoStatsModel.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /monitoring/zones/usage:
 *   get:
 *     summary: Get per-zone usage metrics
 *     description: |
 *       Per-zone CPU/memory/VFS-I/O time series, one row per zone per
 *       system-metrics tick — CPU and memory only. Filter to one machine with
 *       `zone`; `since` turns the answer into a series for graphs, without it
 *       the latest rows come first. rss_bytes is REAL guest memory for running
 *       bhyve machines (bhyvectl Resident memory) and memory_cap rss otherwise.
 *       DISK I/O is NOT here — it is per-ZVOL, not per-machine: see
 *       GET /monitoring/zones/diskio.
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

/**
 * @swagger
 * /monitoring/zones/diskio:
 *   get:
 *     summary: Get per-machine, per-zvol disk I/O
 *     description: |
 *       Guest-requested disk I/O, one row per (machine, ZVOL) per DTrace
 *       interval — NOT aggregated per machine, because a machine's boot and
 *       data volumes can live on different pools/arrays. Each row carries the
 *       `dataset`, its `pool` (the array) and `device` (the volume's leaf name,
 *       matching the machine's disk attr), interval counters (read_ops /
 *       read_bytes / write_ops / write_bytes) and the derived per-second rates.
 *
 *       Source: the only one that exists on this platform — a long-lived DTrace
 *       consumer on the guests' pread/pwrite syscalls (no objset kstats on
 *       illumos ZFS, no zvol block kstat, and zone_vfs never sees bhyve's
 *       raw-zvol traffic). Semantics: what the machine ASKED the host for, not
 *       physical pool I/O after ARC and compression.
 *
 *       An empty answer with machines running means the DTrace consumer is not
 *       running — check host_monitoring.zvol_io.enabled and the agent's dtrace
 *       privileges (the collector logs loudly when it cannot start).
 *     tags: [Host Monitoring]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: zone
 *         schema:
 *           type: string
 *         description: Filter by machine name
 *       - in: query
 *         name: dataset
 *         schema:
 *           type: string
 *         description: Filter to one ZVOL (e.g. "Array-0/zones/8009--web-01.m4kr.net/boot")
 *       - in: query
 *         name: pool
 *         schema:
 *           type: string
 *         description: Filter to one pool/array
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Return intervals after this timestamp
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 200
 *         description: Maximum rows (1-1000)
 *     responses:
 *       200:
 *         description: Per-zvol disk I/O intervals (newest first)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 diskio:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ZvolIoStats'
 *                 totalCount:
 *                   type: integer
 *                 returnedCount:
 *                   type: integer
 *       500:
 *         description: Failed to get disk I/O
 */
export const getZoneDiskIo = async (req, res) => {
  try {
    const { zone, dataset, pool, since } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 1000);

    const where = {};
    if (zone) {
      where.zone_name = zone;
    }
    if (dataset) {
      where.dataset = dataset;
    }
    if (pool) {
      where.pool = pool;
    }
    if (since) {
      where.scan_timestamp = { [Op.gt]: new Date(since) };
    }

    const { count, rows } = await ZvolIoStats.findAndCountAll({
      where,
      order: [
        ['scan_timestamp', 'DESC'],
        ['zone_name', 'ASC'],
        ['dataset', 'ASC'],
      ],
      limit,
    });

    return res.json({
      diskio: rows,
      totalCount: count,
      returnedCount: rows.length,
    });
  } catch (error) {
    log.api.error('Error getting per-zvol disk I/O', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get disk I/O',
      details: error.message,
    });
  }
};
