/**
 * @fileoverview Storage I/O Controller for Host Monitoring
 * @description Disk I/O, pool I/O, and ZFS ARC time-series endpoints
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import DiskIOStats from '../../models/DiskIOStatsModel.js';
import PoolIOStats from '../../models/PoolIOStatsModel.js';
import {
  buildStorageWhereClause,
  DISK_IO_ATTRIBUTES,
  POOL_IO_ATTRIBUTES,
} from './utils/QueryHelpers.js';
import {
  getLatestPerEntity,
  sampleByEntityAndTime,
  sortByEntityAndTime,
  buildSamplingMetadata,
  createEmptyResponse,
  addQueryTiming,
} from './utils/SamplingHelpers.js';

/**
 * @swagger
 * /monitoring/storage/disk-io:
 *   get:
 *     summary: Get disk I/O statistics
 *     description: Returns per-disk I/O performance metrics from zpool iostat -Hv
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
 *         name: pool
 *         schema:
 *           type: string
 *         description: Filter by pool name
 *       - in: query
 *         name: device
 *         schema:
 *           type: string
 *         description: Filter by device name (partial match)
 *       - in: query
 *         name: per_device
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Group results per device
 *     responses:
 *       200:
 *         description: Disk I/O statistics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 diskio:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/DiskIOStats'
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
 *                     entityCount:
 *                       type: integer
 *                     samplesPerEntity:
 *                       type: integer
 *                 queryTime:
 *                   type: string
 *                   description: Server-side query duration (e.g. "12ms")
 *       500:
 *         description: Failed to get disk I/O statistics
 */
export const getDiskIOStats = async (req, res) => {
  const startTime = Date.now();

  try {
    const { limit = 100, since, pool, device, per_device = 'true' } = req.query;
    const requestedLimit = parseInt(limit);

    if (per_device === 'true') {
      if (!since) {
        const whereClause = buildStorageWhereClause({ pool, device });

        const recentRecords = await DiskIOStats.findAll({
          attributes: DISK_IO_ATTRIBUTES,
          where: whereClause,
          order: [['scan_timestamp', 'DESC']],
        });

        if (recentRecords.length === 0) {
          return res.json(createEmptyResponse(startTime, 'latest-per-device-fast'));
        }

        const results = getLatestPerEntity(recentRecords, 'device_name');

        return res.json(
          addQueryTiming(
            {
              diskio: results,
              totalCount: results.length,
              returnedCount: results.length,
              sampling: buildSamplingMetadata({
                applied: true,
                strategy: 'latest-per-device-fast',
                entityCount: results.length,
                samplesPerEntity: 1,
              }),
            },
            startTime
          )
        );
      }

      const whereClause = buildStorageWhereClause({ pool, device, since });

      const allData = await DiskIOStats.findAll({
        attributes: DISK_IO_ATTRIBUTES,
        where: whereClause,
        order: [
          ['device_name', 'ASC'],
          ['scan_timestamp', 'ASC'],
        ],
      });

      if (allData.length === 0) {
        return res.json(createEmptyResponse(startTime, 'javascript-time-sampling'));
      }

      const sampledResults = sampleByEntityAndTime(allData, 'device_name', requestedLimit);
      const sortedResults = sortByEntityAndTime(sampledResults, 'device_name');

      const deviceNames = [...new Set(sortedResults.map(row => row.device_name))];

      return res.json(
        addQueryTiming(
          {
            diskio: sortedResults,
            totalCount: sortedResults.length,
            returnedCount: sortedResults.length,
            sampling: buildSamplingMetadata({
              applied: true,
              strategy: 'javascript-time-sampling',
              entityCount: deviceNames.length,
              samplesPerEntity: Math.round(sortedResults.length / deviceNames.length),
              requestedSamplesPerEntity: requestedLimit,
            }),
          },
          startTime
        )
      );
    }

    const whereClause = buildStorageWhereClause({ pool, device, since });

    const { count, rows } = await DiskIOStats.findAndCountAll({
      where: whereClause,
      attributes: DISK_IO_ATTRIBUTES,
      limit: requestedLimit,
      order: [['scan_timestamp', 'DESC']],
    });

    return res.json(
      addQueryTiming(
        {
          diskio: rows,
          totalCount: count,
          returnedCount: rows.length,
          sampling: buildSamplingMetadata({
            applied: false,
            strategy: 'simple-limit-latest',
          }),
        },
        startTime
      )
    );
  } catch (error) {
    return res.status(500).json(
      addQueryTiming(
        {
          error: 'Failed to get disk I/O statistics',
          details: error.message,
        },
        startTime
      )
    );
  }
};

/**
 * @swagger
 * /monitoring/storage/pool-io:
 *   get:
 *     summary: Get pool I/O performance statistics
 *     description: Returns pool-level I/O performance metrics with latency data from zpool iostat -l -v
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
 *         name: pool
 *         schema:
 *           type: string
 *         description: Filter by pool name
 *       - in: query
 *         name: pool_type
 *         schema:
 *           type: string
 *         description: Filter by pool type (raidz1, raidz2, mirror)
 *       - in: query
 *         name: per_pool
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Group results per pool
 *     responses:
 *       200:
 *         description: Pool I/O performance data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 poolio:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/PoolIOStats'
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
 *                     entityCount:
 *                       type: integer
 *                     samplesPerEntity:
 *                       type: integer
 *                 queryTime:
 *                   type: string
 *                   description: Server-side query duration (e.g. "12ms")
 *       500:
 *         description: Failed to get pool I/O statistics
 */
export const getPoolIOStats = async (req, res) => {
  const startTime = Date.now();

  try {
    const { limit = 100, since, pool, pool_type, per_pool = 'true' } = req.query;
    const requestedLimit = parseInt(limit);

    if (per_pool === 'true') {
      if (!since) {
        const whereClause = buildStorageWhereClause({ pool, pool_type });

        const recentRecords = await PoolIOStats.findAll({
          attributes: POOL_IO_ATTRIBUTES,
          where: whereClause,
          order: [['scan_timestamp', 'DESC']],
        });

        if (recentRecords.length === 0) {
          return res.json(createEmptyResponse(startTime, 'latest-per-pool-fast'));
        }

        const results = getLatestPerEntity(recentRecords, 'pool');

        return res.json(
          addQueryTiming(
            {
              poolio: results,
              totalCount: results.length,
              returnedCount: results.length,
              sampling: buildSamplingMetadata({
                applied: true,
                strategy: 'latest-per-pool-fast',
                entityCount: results.length,
                samplesPerEntity: 1,
              }),
            },
            startTime
          )
        );
      }

      const whereClause = buildStorageWhereClause({ pool, pool_type, since });

      const allData = await PoolIOStats.findAll({
        attributes: POOL_IO_ATTRIBUTES,
        where: whereClause,
        order: [
          ['pool', 'ASC'],
          ['scan_timestamp', 'ASC'],
        ],
      });

      if (allData.length === 0) {
        return res.json(createEmptyResponse(startTime, 'javascript-time-sampling'));
      }

      const sampledResults = sampleByEntityAndTime(allData, 'pool', requestedLimit);
      const sortedResults = sortByEntityAndTime(sampledResults, 'pool');

      const poolNames = [...new Set(sortedResults.map(row => row.pool))];

      return res.json(
        addQueryTiming(
          {
            poolio: sortedResults,
            totalCount: sortedResults.length,
            returnedCount: sortedResults.length,
            sampling: buildSamplingMetadata({
              applied: true,
              strategy: 'javascript-time-sampling',
              entityCount: poolNames.length,
              samplesPerEntity: Math.round(sortedResults.length / poolNames.length),
              requestedSamplesPerEntity: requestedLimit,
            }),
          },
          startTime
        )
      );
    }

    const whereClause = buildStorageWhereClause({ pool, pool_type, since });

    const { count, rows } = await PoolIOStats.findAndCountAll({
      where: whereClause,
      attributes: POOL_IO_ATTRIBUTES,
      limit: requestedLimit,
      order: [['scan_timestamp', 'DESC']],
    });

    return res.json(
      addQueryTiming(
        {
          poolio: rows,
          totalCount: count,
          returnedCount: rows.length,
          sampling: buildSamplingMetadata({
            applied: false,
            strategy: 'simple-limit-latest',
          }),
        },
        startTime
      )
    );
  } catch (error) {
    return res.status(500).json(
      addQueryTiming(
        {
          error: 'Failed to get pool I/O statistics',
          details: error.message,
        },
        startTime
      )
    );
  }
};
