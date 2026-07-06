/**
 * @fileoverview Storage Monitoring Controller for Host Monitoring
 * @description Handles ZFS pools, datasets, disks, and I/O statistics monitoring
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import ZFSPools from '../../models/ZFSPoolModel.js';
import ZFSDatasets from '../../models/ZFSDatasetModel.js';
import Disks from '../../models/DiskModel.js';
import DiskIOStats from '../../models/DiskIOStatsModel.js';
import PoolIOStats from '../../models/PoolIOStatsModel.js';
import ARCStats from '../../models/ARCStatsModel.js';
import {
  buildStorageWhereClause,
  buildPagination,
  DISK_IO_ATTRIBUTES,
  POOL_IO_ATTRIBUTES,
  ARC_STATS_ATTRIBUTES,
} from './utils/QueryHelpers.js';
import {
  getLatestPerEntity,
  sampleByEntityAndTime,
  sortByEntityAndTime,
  buildSamplingMetadata,
  createEmptyResponse,
  addQueryTiming,
  calculateTimeSpan,
  sampleByTime,
} from './utils/SamplingHelpers.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /monitoring/storage/pools:
 *   get:
 *     summary: Get ZFS pool information
 *     description: Returns ZFS pool status, I/O statistics, and health information
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of records to return
 *       - in: query
 *         name: pool
 *         schema:
 *           type: string
 *         description: Filter by pool name
 *       - in: query
 *         name: health
 *         schema:
 *           type: string
 *         description: Filter by pool health status
 *     responses:
 *       200:
 *         description: ZFS pool data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pools:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ZFSPool'
 *                 totalCount:
 *                   type: integer
 *       500:
 *         description: Failed to get ZFS pools
 */
export const getZFSPools = async (req, res) => {
  try {
    const { limit = 50, pool, health } = req.query;

    const whereClause = buildStorageWhereClause({ pool, health });

    const { count, rows } = await ZFSPools.findAndCountAll({
      where: whereClause,
      limit: parseInt(limit),
      order: [
        ['scan_timestamp', 'DESC'],
        ['pool', 'ASC'],
      ],
    });

    return res.json({
      pools: rows,
      totalCount: count,
    });
  } catch (error) {
    log.api.error('Error getting ZFS pools', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get ZFS pools',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /monitoring/storage/datasets:
 *   get:
 *     summary: Get ZFS dataset information
 *     description: Returns ZFS dataset properties, usage, and configuration
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of records to skip
 *       - in: query
 *         name: pool
 *         schema:
 *           type: string
 *         description: Filter by pool name
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *         description: Filter by dataset type (filesystem, volume, snapshot)
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *         description: Filter by dataset name (partial match)
 *     responses:
 *       200:
 *         description: ZFS dataset data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 datasets:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ZFSDataset'
 *                 totalCount:
 *                   type: integer
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *                     hasMore:
 *                       type: boolean
 *       500:
 *         description: Failed to get ZFS datasets
 */
export const getZFSDatasets = async (req, res) => {
  try {
    const { limit = 100, offset = 0, pool, type, name } = req.query;

    const whereClause = buildStorageWhereClause({ pool, type, name });

    const { count, rows } = await ZFSDatasets.findAndCountAll({
      where: whereClause,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [
        ['scan_timestamp', 'DESC'],
        ['name', 'ASC'],
      ],
    });

    return res.json({
      datasets: rows,
      totalCount: count,
      pagination: buildPagination(limit, offset, count),
    });
  } catch (error) {
    log.api.error('Error getting ZFS datasets', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get ZFS datasets',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /monitoring/storage/disks:
 *   get:
 *     summary: Get physical disk information
 *     description: Returns physical disk inventory including serial numbers, capacities, and pool assignments
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of records to skip
 *       - in: query
 *         name: pool
 *         schema:
 *           type: string
 *         description: Filter by pool assignment
 *       - in: query
 *         name: available
 *         schema:
 *           type: boolean
 *         description: Filter by availability status
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *         description: Filter by disk type (SSD, HDD)
 *     responses:
 *       200:
 *         description: Physical disk data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 disks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Disk'
 *                 totalCount:
 *                   type: integer
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *                     hasMore:
 *                       type: boolean
 *       500:
 *         description: Failed to get disk information
 */
export const getDisks = async (req, res) => {
  try {
    const { limit = 100, offset = 0, pool, available, type } = req.query;

    const whereClause = buildStorageWhereClause({
      pool,
      available,
      disk_type: type,
    });

    const { count, rows } = await Disks.findAndCountAll({
      where: whereClause,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [
        ['scan_timestamp', 'DESC'],
        ['disk_index', 'ASC'],
      ],
    });

    return res.json({
      disks: rows,
      totalCount: count,
      pagination: buildPagination(limit, offset, count),
    });
  } catch (error) {
    log.api.error('Error getting disk information', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get disk information',
      details: error.message,
    });
  }
};

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
        // Latest per device using optimized sampling
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

      // Historical sampling with time distribution
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

    // Simple query without per-device logic
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
        // Latest per pool using optimized sampling
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

      // Historical sampling with time distribution
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

    // Simple query without per-pool logic
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

/**
 * @swagger
 * /monitoring/storage/arc:
 *   get:
 *     summary: Get ZFS ARC statistics
 *     description: Returns ZFS Adaptive Replacement Cache performance metrics
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
 *         description: ARC statistics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 arc:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ARCStats'
 *                 latest:
 *                   $ref: '#/components/schemas/ARCStats'
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
 *         description: Failed to get ARC statistics
 */
export const getARCStats = async (req, res) => {
  const startTime = Date.now();

  try {
    const { limit = 100, since } = req.query;
    const requestedLimit = parseInt(limit);

    if (!since) {
      // Latest system-wide ARC stats
      const latestRecord = await ARCStats.findOne({
        attributes: ARC_STATS_ATTRIBUTES,
        order: [['scan_timestamp', 'DESC']],
      });

      const results = latestRecord ? [latestRecord] : [];

      return res.json(
        addQueryTiming(
          {
            arc: results,
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

    // Historical sampling across time range
    const whereClause = buildStorageWhereClause({ since });

    const allData = await ARCStats.findAll({
      attributes: ARC_STATS_ATTRIBUTES,
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
          arc: sampledResults,
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
          error: 'Failed to get ARC statistics',
          details: error.message,
        },
        startTime
      )
    );
  }
};
