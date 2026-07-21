/**
 * @fileoverview System Load Controller for Host Monitoring
 * @description System load and activity metrics (load averages, context switches, paging)
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import CPUStats from '../../models/CPUStatsModel.js';
import { buildSystemMetricsWhereClause } from './utils/QueryHelpers.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /monitoring/system/load:
 *   get:
 *     summary: Get system load metrics
 *     description: Returns system load indicators including context switches, interrupts, page faults, and system calls
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Return records since this timestamp
 *     responses:
 *       200:
 *         description: System load metrics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 load:
 *                   type: array
 *                   description: Load metrics reshaped for charting (NOT the raw CPUStats schema)
 *                   items:
 *                     type: object
 *                     properties:
 *                       timestamp:
 *                         type: string
 *                         format: date-time
 *                       load_averages:
 *                         type: object
 *                         properties:
 *                           one_min:
 *                             type: number
 *                           five_min:
 *                             type: number
 *                           fifteen_min:
 *                             type: number
 *                       system_activity:
 *                         type: object
 *                         properties:
 *                           context_switches_per_sec:
 *                             type: number
 *                           interrupts_per_sec:
 *                             type: number
 *                           system_calls_per_sec:
 *                             type: number
 *                           page_faults_per_sec:
 *                             type: number
 *                       memory_pressure:
 *                         type: object
 *                         properties:
 *                           pages_in_per_sec:
 *                             type: number
 *                           pages_out_per_sec:
 *                             type: number
 *                       process_activity:
 *                         type: object
 *                         properties:
 *                           running:
 *                             type: integer
 *                           blocked:
 *                             type: integer
 *                       cpu_count:
 *                         type: integer
 *                 totalCount:
 *                   type: integer
 *                 latest:
 *                   type: object
 *                   description: The most recent load-metrics entry (same shape as a load[] item), or null
 *                   nullable: true
 *                 metadata:
 *                   type: object
 *                   properties:
 *                     description:
 *                       type: string
 *                     metrics_included:
 *                       type: array
 *                       items:
 *                         type: string
 *       500:
 *         description: Failed to get system load metrics
 */
export const getSystemLoadMetrics = async (req, res) => {
  try {
    const { limit = 100, since } = req.query;

    const whereClause = buildSystemMetricsWhereClause({ since });

    const { count, rows } = await CPUStats.findAndCountAll({
      where: whereClause,
      limit: parseInt(limit),
      order: [['scan_timestamp', 'DESC']],
      attributes: [
        'scan_timestamp',
        'load_avg_1min',
        'load_avg_5min',
        'load_avg_15min',
        'context_switches',
        'interrupts',
        'system_calls',
        'page_faults',
        'page_ins',
        'page_outs',
        'processes_running',
        'processes_blocked',
        'cpu_count',
      ],
    });

    const loadMetrics = rows.map(row => ({
      timestamp: row.scan_timestamp,
      load_averages: {
        one_min: row.load_avg_1min,
        five_min: row.load_avg_5min,
        fifteen_min: row.load_avg_15min,
      },
      system_activity: {
        context_switches_per_sec: row.context_switches,
        interrupts_per_sec: row.interrupts,
        system_calls_per_sec: row.system_calls,
        page_faults_per_sec: row.page_faults,
      },
      memory_pressure: {
        pages_in_per_sec: row.page_ins,
        pages_out_per_sec: row.page_outs,
      },
      process_activity: {
        running: row.processes_running,
        blocked: row.processes_blocked,
      },
      cpu_count: row.cpu_count,
    }));

    const latest = loadMetrics.length > 0 ? loadMetrics[0] : null;

    return res.json({
      load: loadMetrics,
      totalCount: count,
      latest,
      metadata: {
        description: 'System load and activity metrics',
        metrics_included: [
          'Load averages (1, 5, 15 min)',
          'Context switches per second',
          'Interrupts per second',
          'System calls per second',
          'Page faults per second',
          'Memory paging activity',
          'Process queue status',
        ],
      },
    });
  } catch (error) {
    log.api.error('Error getting system load metrics', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get system load metrics',
      details: error.message,
    });
  }
};
