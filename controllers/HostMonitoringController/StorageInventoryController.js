/**
 * @fileoverview Storage Inventory Controller for Host Monitoring
 * @description ZFS pool, dataset, and physical disk inventory endpoints
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import ZFSPools from '../../models/ZFSPoolModel.js';
import ZFSDatasets from '../../models/ZFSDatasetModel.js';
import Disks from '../../models/DiskModel.js';
import { buildStorageWhereClause, buildPagination } from './utils/QueryHelpers.js';
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
