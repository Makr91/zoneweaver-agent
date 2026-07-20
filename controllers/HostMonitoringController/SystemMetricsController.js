/**
 * @fileoverview System Metrics Controller for Host Monitoring
 * @description Handles CPU statistics, memory statistics, and system load metrics
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import CPUStats from '../../models/CPUStatsModel.js';
import MemoryStats from '../../models/MemoryStatsModel.js';
import {
  buildSystemMetricsWhereClause,
  CPU_STATS_ATTRIBUTES,
  MEMORY_STATS_ATTRIBUTES,
} from './utils/QueryHelpers.js';
import {
  sampleByTime,
  buildSamplingMetadata,
  createEmptyResponse,
  addQueryTiming,
  calculateTimeSpan,
} from './utils/SamplingHelpers.js';
import { log } from '../../lib/Logger.js';
import { expandPerCoreData } from './utils/CpuCoreHelpers.js';

/**
 * @swagger
 * /monitoring/system/cpu:
 *   get:
 *     summary: Get CPU statistics
 *     description: Returns CPU performance statistics including utilization, load averages, and process counts
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
 *       - in: query
 *         name: include_cores
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include per-core CPU utilization data (adds a parsed `per_core_parsed` array to each item and the `latest` object, replacing the raw `per_core_data` column)
 *     responses:
 *       200:
 *         description: CPU statistics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 cpu:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/CPUStats'
 *                 latest:
 *                   $ref: '#/components/schemas/CPUStats'
 *                 totalCount:
 *                   type: integer
 *                 returnedCount:
 *                   type: integer
 *                   description: Number of records in this response
 *                 sampling:
 *                   type: object
 *                   description: Time-series sampling metadata applied to the result set
 *                   properties:
 *                     applied:
 *                       type: boolean
 *                     strategy:
 *                       type: string
 *                     samplesRequested:
 *                       type: integer
 *                     samplesReturned:
 *                       type: integer
 *                 metadata:
 *                   type: object
 *                   description: Present on the historical (since) path
 *                   properties:
 *                     timeSpan:
 *                       type: object
 *                       properties:
 *                         start:
 *                           type: string
 *                           format: date-time
 *                         end:
 *                           type: string
 *                           format: date-time
 *                         durationMinutes:
 *                           type: integer
 *                 queryTime:
 *                   type: string
 *                   description: Server-side query duration (e.g. "12ms")
 *       500:
 *         description: Failed to get CPU statistics
 */
export const getCPUStats = async (req, res) => {
  const startTime = Date.now();

  try {
    const { limit = 100, since, include_cores = false } = req.query;
    const requestedLimit = parseInt(limit);

    const selectedAttributes = [...CPU_STATS_ATTRIBUTES];

    if (include_cores === 'true' || include_cores === true) {
      selectedAttributes.push('per_core_data');
    }

    if (!since) {
      const latestRecord = await CPUStats.findOne({
        attributes: selectedAttributes,
        order: [['scan_timestamp', 'DESC']],
      });

      const latest = latestRecord ? latestRecord.get({ plain: true }) : null;
      if ((include_cores === 'true' || include_cores === true) && latestRecord?.per_core_data) {
        latest.per_core_parsed = expandPerCoreData(latestRecord.per_core_data);
        delete latest.per_core_data;
      }

      const results = latest ? [latest] : [];

      return res.json(
        addQueryTiming(
          {
            cpu: results,
            totalCount: results.length,
            returnedCount: results.length,
            latest,
            sampling: buildSamplingMetadata({
              applied: true,
              strategy: 'latest-system-wide',
            }),
          },
          startTime
        )
      );
    }
    const whereClause = buildSystemMetricsWhereClause({ since });

    const allData = await CPUStats.findAll({
      attributes: selectedAttributes,
      where: whereClause,
      order: [['scan_timestamp', 'ASC']],
    });

    if (allData.length === 0) {
      return res.json(createEmptyResponse(startTime, 'javascript-time-sampling'));
    }

    let sampledResults = sampleByTime(allData, requestedLimit);

    if (include_cores === 'true' || include_cores === true) {
      sampledResults = sampledResults.map(row => {
        const plain = row.get({ plain: true });
        if (row.per_core_data) {
          plain.per_core_parsed = expandPerCoreData(row.per_core_data);
          delete plain.per_core_data;
        }
        return plain;
      });
    }

    const timeSpan = calculateTimeSpan(sampledResults);
    const latest = sampledResults.length > 0 ? sampledResults[sampledResults.length - 1] : null;

    return res.json(
      addQueryTiming(
        {
          cpu: sampledResults,
          totalCount: sampledResults.length,
          returnedCount: sampledResults.length,
          latest,
          sampling: buildSamplingMetadata({
            applied: true,
            strategy: 'javascript-time-sampling',
            samplesRequested: requestedLimit,
            samplesReturned: sampledResults.length,
          }),
          metadata: {
            timeSpan,
          },
        },
        startTime
      )
    );
  } catch (error) {
    return res.status(500).json(
      addQueryTiming(
        {
          error: 'Failed to get CPU statistics',
          details: error.message,
        },
        startTime
      )
    );
  }
};

/**
 * @swagger
 * /monitoring/system/memory:
 *   get:
 *     summary: Get memory statistics
 *     description: Returns memory usage statistics including RAM, swap, and ZFS ARC information
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
 *         description: Memory statistics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 memory:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/MemoryStats'
 *                 latest:
 *                   $ref: '#/components/schemas/MemoryStats'
 *                 totalCount:
 *                   type: integer
 *                 returnedCount:
 *                   type: integer
 *                   description: Number of records in this response
 *                 sampling:
 *                   type: object
 *                   description: Time-series sampling metadata applied to the result set
 *                   properties:
 *                     applied:
 *                       type: boolean
 *                     strategy:
 *                       type: string
 *                     samplesRequested:
 *                       type: integer
 *                     samplesReturned:
 *                       type: integer
 *                 metadata:
 *                   type: object
 *                   description: Present on the historical (since) path
 *                   properties:
 *                     timeSpan:
 *                       type: object
 *                       properties:
 *                         start:
 *                           type: string
 *                           format: date-time
 *                         end:
 *                           type: string
 *                           format: date-time
 *                         durationMinutes:
 *                           type: integer
 *                 queryTime:
 *                   type: string
 *                   description: Server-side query duration (e.g. "12ms")
 *       500:
 *         description: Failed to get memory statistics
 */
export const getMemoryStats = async (req, res) => {
  const startTime = Date.now();

  try {
    const { limit = 100, since } = req.query;
    const requestedLimit = parseInt(limit);

    if (!since) {
      const latestRecord = await MemoryStats.findOne({
        attributes: MEMORY_STATS_ATTRIBUTES,
        order: [['scan_timestamp', 'DESC']],
      });

      const results = latestRecord ? [latestRecord] : [];

      return res.json(
        addQueryTiming(
          {
            memory: results,
            totalCount: results.length,
            returnedCount: results.length,
            latest: latestRecord,
            sampling: buildSamplingMetadata({
              applied: true,
              strategy: 'latest-system-wide',
            }),
          },
          startTime
        )
      );
    }

    const whereClause = buildSystemMetricsWhereClause({ since });

    const allData = await MemoryStats.findAll({
      attributes: MEMORY_STATS_ATTRIBUTES,
      where: whereClause,
      order: [['scan_timestamp', 'ASC']],
    });

    if (allData.length === 0) {
      return res.json(createEmptyResponse(startTime, 'javascript-time-sampling'));
    }

    const sampledResults = sampleByTime(allData, requestedLimit);
    const timeSpan = calculateTimeSpan(sampledResults);
    const latest = sampledResults.length > 0 ? sampledResults[sampledResults.length - 1] : null;

    return res.json(
      addQueryTiming(
        {
          memory: sampledResults,
          totalCount: sampledResults.length,
          returnedCount: sampledResults.length,
          latest,
          sampling: buildSamplingMetadata({
            applied: true,
            strategy: 'javascript-time-sampling',
            samplesRequested: requestedLimit,
            samplesReturned: sampledResults.length,
          }),
          metadata: {
            timeSpan,
          },
        },
        startTime
      )
    );
  } catch (error) {
    return res.status(500).json(
      addQueryTiming(
        {
          error: 'Failed to get memory statistics',
          details: error.message,
        },
        startTime
      )
    );
  }
};

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
