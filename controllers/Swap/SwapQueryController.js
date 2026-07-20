/**
 * @fileoverview Swap Query Controller for Zoneweaver Agent
 * @description Provides API endpoints for swap area monitoring on OmniOS systems
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import os from 'os';
import { Op } from 'sequelize';
import SwapArea from '../../models/SwapAreaModel.js';
import MemoryStats from '../../models/MemoryStatsModel.js';
import { getRootPool } from '../../lib/DiskSpec.js';
import { log } from '../../lib/Logger.js';

/**
 * Derive the pool a swap area lives on from its zvol path.
 * The clean swap_areas schema stores no pool_assignment column — the pool is
 * always derivable from the swapfile path (null for non-zvol swap).
 * @param {string} swapfile - Swap device path (e.g. /dev/zvol/dsk/rpool/swap)
 * @returns {string|null} Pool name or null
 */
const poolFromSwapfile = swapfile =>
  swapfile?.match(/\/dev\/zvol\/dsk\/(?<pool>[^/]+)/)?.groups.pool || null;

/**
 * @swagger
 * /system/swap/areas:
 *   get:
 *     summary: List all swap areas
 *     description: Returns detailed information about all swap areas on the system
 *     tags: [Swap Management]
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
 *         description: Filter by pool (derived from the zvol path)
 *     responses:
 *       200:
 *         description: Swap areas data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 swapAreas:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SwapArea'
 *                 totalCount:
 *                   type: integer
 *                 pagination:
 *                   type: object
 *       500:
 *         description: Failed to get swap areas
 */
export const listSwapAreas = async (req, res) => {
  const { limit = 100, offset = 0, pool } = req.query;
  const hostname = os.hostname();

  try {
    // The table only holds CURRENT swap areas (vanished ones are deleted by the
    // collector), so every row is "active" — no is_active column exists.
    const whereClause = { host: hostname };
    if (pool) {
      whereClause.swapfile = { [Op.like]: `/dev/zvol/dsk/${pool}/%` };
    }

    const { count, rows } = await SwapArea.findAndCountAll({
      where: whereClause,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [
        ['scan_timestamp', 'DESC'],
        ['swapfile', 'ASC'],
      ],
    });

    return res.json({
      swapAreas: rows,
      totalCount: count,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: count > parseInt(offset) + parseInt(limit),
      },
    });
  } catch (error) {
    log.api.error('Error listing swap areas', {
      error: error.message,
      stack: error.stack,
      host: hostname,
      filters: { pool },
    });
    return res.status(500).json({
      error: 'Failed to list swap areas',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/swap/summary:
 *   get:
 *     summary: Get swap configuration summary
 *     description: Returns aggregate swap information with configuration analysis
 *     tags: [Swap Management]
 *     responses:
 *       200:
 *         description: Swap summary data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 host:
 *                   type: string
 *                 totalSwapBytes:
 *                   type: integer
 *                 usedSwapBytes:
 *                   type: integer
 *                 freeSwapBytes:
 *                   type: integer
 *                 overallUtilization:
 *                   type: number
 *                 swapAreas:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       path:
 *                         type: string
 *                       pool:
 *                         type: string
 *                       sizeBytes:
 *                         type: integer
 *                       usedBytes:
 *                         type: integer
 *                       utilization:
 *                         type: number
 *                 poolDistribution:
 *                   type: object
 *                 recommendations:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       type:
 *                         type: string
 *                       category:
 *                         type: string
 *                       message:
 *                         type: string
 *                 swapAreaCount:
 *                   type: integer
 *                 lastScanned:
 *                   type: string
 *                   format: date-time
 *                   nullable: true
 *                 memoryStatsReference:
 *                   type: object
 *                   nullable: true
 *                   description: Cross-reference to the latest MemoryStats swap figures
 *                   properties:
 *                     total_swap_bytes:
 *                       type: integer
 *                       nullable: true
 *                     used_swap_bytes:
 *                       type: integer
 *                       nullable: true
 *                     utilization_pct:
 *                       type: number
 *       500:
 *         description: Failed to get swap summary
 */
export const getSwapSummary = async (req, res) => {
  void req;
  const hostname = os.hostname();

  try {
    // Get current swap areas (the table only ever holds the current configuration)
    const swapAreas = await SwapArea.findAll({
      where: {
        host: hostname,
      },
      order: [
        ['scan_timestamp', 'DESC'],
        ['swapfile', 'ASC'],
      ],
    });

    // Get latest memory stats for cross-reference
    const latestMemoryStats = await MemoryStats.findOne({
      where: { host: hostname },
      order: [['scan_timestamp', 'DESC']],
    });

    // Calculate aggregates
    const totalSwapBytes = swapAreas.reduce((sum, area) => sum + Number(area.size_bytes), 0);
    const usedSwapBytes = swapAreas.reduce((sum, area) => sum + Number(area.used_bytes), 0);
    const freeSwapBytes = totalSwapBytes - usedSwapBytes;
    const overallUtilization = totalSwapBytes > 0 ? (usedSwapBytes / totalSwapBytes) * 100 : 0;

    // Pool distribution analysis (pool derived from the zvol path)
    const rootPool = await getRootPool();
    const poolDistribution = {};
    const rootPoolAreas = [];
    swapAreas.forEach(area => {
      const pool = poolFromSwapfile(area.swapfile) || 'unknown';
      if (!poolDistribution[pool]) {
        poolDistribution[pool] = {
          count: 0,
          totalSizeGB: 0,
          usedSizeGB: 0,
          areas: [],
        };
      }
      poolDistribution[pool].count++;
      poolDistribution[pool].totalSizeGB += Number(area.size_bytes) / 1024 ** 3;
      poolDistribution[pool].usedSizeGB += Number(area.used_bytes) / 1024 ** 3;
      poolDistribution[pool].areas.push(area.swapfile);

      if (pool === rootPool) {
        rootPoolAreas.push(area);
      }
    });

    // Generate recommendations
    const recommendations = [];

    // Multiple root-pool swap areas run against best practice
    if (rootPoolAreas.length > 1) {
      recommendations.push({
        type: 'warning',
        category: 'best_practice',
        message: `Found ${rootPoolAreas.length} swap areas on ${rootPool}. Consider consolidating to one small swap area on ${rootPool} and moving larger swap to arrays.`,
        affected_areas: rootPoolAreas.map(area => area.swapfile),
      });
    }

    // Check for high utilization
    if (overallUtilization > 50) {
      recommendations.push({
        type: 'alert',
        category: 'utilization',
        message: `Swap utilization is ${overallUtilization.toFixed(1)}% which exceeds the 50% threshold.`,
        action: 'Consider adding more swap space',
      });
    }

    // Check for very large root-pool swap areas
    rootPoolAreas.forEach(area => {
      const sizeGB = Number(area.size_bytes) / 1024 ** 3;
      if (sizeGB > 10) {
        recommendations.push({
          type: 'suggestion',
          category: 'optimization',
          message: `Swap area ${area.swapfile} is ${sizeGB.toFixed(1)}GB on ${rootPool}. Consider moving large swap to an array.`,
          affected_areas: [area.swapfile],
        });
      }
    });

    return res.json({
      host: hostname,
      totalSwapBytes,
      usedSwapBytes,
      freeSwapBytes,
      overallUtilization: parseFloat(overallUtilization.toFixed(2)),
      swapAreaCount: swapAreas.length,
      // Response keys keep the external names (path/pool) — only the storage
      // schema is swapfile-based
      swapAreas: swapAreas.map(area => ({
        path: area.swapfile,
        pool: poolFromSwapfile(area.swapfile),
        sizeBytes: Number(area.size_bytes),
        usedBytes: Number(area.used_bytes),
        utilization: parseFloat(area.utilization_pct),
      })),
      poolDistribution,
      recommendations,
      lastScanned: swapAreas.length > 0 ? swapAreas[0].scan_timestamp : null,
      memoryStatsReference: latestMemoryStats
        ? {
            total_swap_bytes: latestMemoryStats.swap_total_bytes
              ? Number(latestMemoryStats.swap_total_bytes)
              : null,
            used_swap_bytes: latestMemoryStats.swap_used_bytes
              ? Number(latestMemoryStats.swap_used_bytes)
              : null,
            utilization_pct: latestMemoryStats.swap_utilization_pct,
          }
        : null,
    });
  } catch (error) {
    log.api.error('Error getting swap summary', {
      error: error.message,
      stack: error.stack,
      host: hostname,
    });
    return res.status(500).json({
      error: 'Failed to get swap summary',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /monitoring/hosts/low-swap:
 *   get:
 *     summary: Get hosts with low swap space
 *     description: Returns hosts with swap utilization above the specified threshold
 *     tags: [Swap Management]
 *     parameters:
 *       - in: query
 *         name: threshold
 *         schema:
 *           type: number
 *           default: 50
 *         description: Utilization threshold percentage
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of hosts to return
 *     responses:
 *       200:
 *         description: Hosts with low swap space
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 hostsWithLowSwap:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       host:
 *                         type: string
 *                       swap_total_bytes:
 *                         type: integer
 *                       swap_used_bytes:
 *                         type: integer
 *                       swap_utilization_pct:
 *                         type: number
 *                       last_checked:
 *                         type: string
 *                         format: date-time
 *                 totalCount:
 *                   type: integer
 *                 threshold:
 *                   type: number
 *       500:
 *         description: Failed to get hosts with low swap
 */
export const getHostsWithLowSwap = async (req, res) => {
  const { threshold = 50, limit = 100 } = req.query;

  try {
    // Get latest memory stats for all hosts where swap utilization exceeds threshold
    const hostsWithLowSwap = await MemoryStats.findAll({
      attributes: [
        'host',
        'swap_total_bytes',
        'swap_used_bytes',
        'swap_utilization_pct',
        'scan_timestamp',
      ],
      where: {
        swap_utilization_pct: { [Op.gt]: threshold },
        scan_timestamp: {
          [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
        },
      },
      order: [
        ['host', 'ASC'],
        ['scan_timestamp', 'DESC'],
      ],
      limit: parseInt(limit),
    });

    // Group by host and get the latest entry for each
    const hostMap = new Map();
    hostsWithLowSwap.forEach(record => {
      if (
        !hostMap.has(record.host) ||
        record.scan_timestamp > hostMap.get(record.host).scan_timestamp
      ) {
        hostMap.set(record.host, record);
      }
    });

    const results = Array.from(hostMap.values()).map(record => ({
      host: record.host,
      swap_total_bytes: record.swap_total_bytes ? Number(record.swap_total_bytes) : 0,
      swap_used_bytes: record.swap_used_bytes ? Number(record.swap_used_bytes) : 0,
      swap_utilization_pct: parseFloat(record.swap_utilization_pct || 0),
      last_checked: record.scan_timestamp,
    }));

    return res.json({
      hostsWithLowSwap: results,
      totalCount: results.length,
      threshold: parseFloat(threshold),
      message:
        results.length === 0
          ? 'No hosts found with swap utilization above threshold'
          : `Found ${results.length} host(s) with swap utilization above ${threshold}%`,
    });
  } catch (error) {
    log.api.error('Error getting hosts with low swap', {
      error: error.message,
      stack: error.stack,
      threshold,
    });
    return res.status(500).json({
      error: 'Failed to get hosts with low swap',
      details: error.message,
    });
  }
};
