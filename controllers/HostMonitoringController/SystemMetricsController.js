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
