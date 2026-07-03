/**
 * @fileoverview Swap Management Controller for Zoneweaver Agent
 * @description Provides API endpoints for swap area monitoring and management on OmniOS systems
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import os from 'os';
import { Op } from 'sequelize';
import SwapArea from '../models/SwapAreaModel.js';
import MemoryStats from '../models/MemoryStatsModel.js';
import { log } from '../lib/Logger.js';

const execProm = util.promisify(exec);

/**
 * Helper function to parse ZFS size strings (e.g., "1.2T", "500G", "2.5M")
 * @param {string} sizeString - Size string from ZFS commands
 * @returns {number} Size in bytes
 */
const parseZfsSize = sizeString => {
  const sizeRegex = /^(?<value>[\d.]+)(?<unit>[KMGTPEZ]?)$/i;
  const match = sizeString.match(sizeRegex);

  if (!match) {
    return 0;
  }

  const { value: valueStr, unit: unitStr } = match.groups;
  const value = parseFloat(valueStr);
  const unit = unitStr.toUpperCase();

  const multipliers = {
    '': 1,
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
    P: 1024 ** 5,
    E: 1024 ** 6,
    Z: 1024 ** 7,
  };

  return value * (multipliers[unit] || 1);
};

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
 *         description: Filter by pool assignment
 *       - in: query
 *         name: active_only
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Show only active swap areas
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
  const { limit = 100, offset = 0, pool, active_only = true, host } = req.query;
  const hostname = host || os.hostname();

  try {
    const whereClause = { host: hostname };
    if (pool) {
      whereClause.pool_assignment = pool;
    }
    if (active_only === 'true' || active_only === true) {
      whereClause.is_active = true;
    }

    const { count, rows } = await SwapArea.findAndCountAll({
      where: whereClause,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [
        ['scan_timestamp', 'DESC'],
        ['path', 'ASC'],
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
      filters: { pool, active_only },
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
 *                 totalSwapGB:
 *                   type: number
 *                 usedSwapGB:
 *                   type: number
 *                 freeSwapGB:
 *                   type: number
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
 *                       sizeGB:
 *                         type: string
 *                       usedGB:
 *                         type: string
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
 *       500:
 *         description: Failed to get swap summary
 */
export const getSwapSummary = async (req, res) => {
  const { host } = req.query;
  const hostname = host || os.hostname();

  try {
    // Get current swap areas
    const swapAreas = await SwapArea.findAll({
      where: {
        host: hostname,
        is_active: true,
      },
      order: [
        ['scan_timestamp', 'DESC'],
        ['path', 'ASC'],
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

    // Pool distribution analysis
    const poolDistribution = {};
    const rpoolAreas = [];
    swapAreas.forEach(area => {
      const pool = area.pool_assignment || 'unknown';
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
      poolDistribution[pool].areas.push(area.path);

      if (pool === 'rpool') {
        rpoolAreas.push(area);
      }
    });

    // Generate recommendations
    const recommendations = [];

    // Check for multiple rpool swap areas (against best practice)
    if (rpoolAreas.length > 1) {
      recommendations.push({
        type: 'warning',
        category: 'best_practice',
        message: `Found ${rpoolAreas.length} swap areas on rpool. Consider consolidating to one small swap area on rpool and moving larger swap to arrays.`,
        affected_areas: rpoolAreas.map(area => area.path),
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

    // Check for very large rpool swap areas
    rpoolAreas.forEach(area => {
      const sizeGB = Number(area.size_bytes) / 1024 ** 3;
      if (sizeGB > 10) {
        recommendations.push({
          type: 'suggestion',
          category: 'optimization',
          message: `Swap area ${area.path} is ${sizeGB.toFixed(1)}GB on rpool. Consider moving large swap to an array.`,
          affected_areas: [area.path],
        });
      }
    });

    return res.json({
      host: hostname,
      totalSwapGB: (totalSwapBytes / 1024 ** 3).toFixed(2),
      usedSwapGB: (usedSwapBytes / 1024 ** 3).toFixed(2),
      freeSwapGB: (freeSwapBytes / 1024 ** 3).toFixed(2),
      overallUtilization: parseFloat(overallUtilization.toFixed(2)),
      swapAreaCount: swapAreas.length,
      swapAreas: swapAreas.map(area => ({
        path: area.path,
        pool: area.pool_assignment,
        sizeGB: (Number(area.size_bytes) / 1024 ** 3).toFixed(2),
        usedGB: (Number(area.used_bytes) / 1024 ** 3).toFixed(2),
        utilization: parseFloat(area.utilization_pct),
      })),
      poolDistribution,
      recommendations,
      lastScanned: swapAreas.length > 0 ? swapAreas[0].scan_timestamp : null,
      memoryStatsReference: latestMemoryStats
        ? {
            total_swap_gb: latestMemoryStats.swap_total_bytes
              ? (Number(latestMemoryStats.swap_total_bytes) / 1024 ** 3).toFixed(2)
              : null,
            used_swap_gb: latestMemoryStats.swap_used_bytes
              ? (Number(latestMemoryStats.swap_used_bytes) / 1024 ** 3).toFixed(2)
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
 * /system/swap/add:
 *   post:
 *     summary: Add a new swap area
 *     description: Adds a new swap area with safety validations
 *     tags: [Swap Management]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - path
 *             properties:
 *               path:
 *                 type: string
 *                 description: Path to swap device/file
 *                 example: "/dev/zvol/dsk/Array-0/swap"
 *               swaplow:
 *                 type: integer
 *                 description: Offset in 512-byte blocks (optional)
 *               swaplen:
 *                 type: integer
 *                 description: Length in 512-byte blocks (optional)
 *     responses:
 *       200:
 *         description: Swap area added successfully
 *       400:
 *         description: Invalid request or safety check failed
 *       500:
 *         description: Failed to add swap area
 */
export const addSwapArea = async (req, res) => {
  const { path, swaplow, swaplen } = req.body;
  let poolAssignment = null;

  try {
    if (!path) {
      return res.status(400).json({
        error: 'Path is required',
      });
    }

    // Extract pool assignment from path
    const poolMatch = path.match(/\/dev\/zvol\/dsk\/(?<pool>[^/]+)/);
    poolAssignment = poolMatch ? poolMatch.groups.pool : null;

    // Safety checks for rpool operations
    if (poolAssignment === 'rpool') {
      // Check available space with 5% buffer
      try {
        const { stdout: zpoolOutput } = await execProm(
          'pfexec zpool list -H -o name,size,free rpool',
          { timeout: 10000 }
        );
        const zpoolData = zpoolOutput.trim().split('\t');
        if (zpoolData.length >= 3) {
          const [, , freeSpace] = zpoolData;
          const freeBytes = parseZfsSize(freeSpace);
          const requestedBytes = swaplen ? swaplen * 512 : 0;
          const bufferBytes = freeBytes * 0.05; // 5% buffer

          if (requestedBytes > 0 && freeBytes - bufferBytes < requestedBytes) {
            return res.status(400).json({
              error: 'Insufficient space on rpool',
              details: `Requested ${(requestedBytes / 1024 ** 3).toFixed(2)}GB but only ${((freeBytes - bufferBytes) / 1024 ** 3).toFixed(2)}GB available (with 5% buffer)`,
            });
          }
        }
      } catch (error) {
        log.monitoring.warn('Could not verify rpool space', {
          error: error.message,
          pool: 'rpool',
          path,
        });
      }
    }

    // Build swap add command
    let command = `pfexec swap -a ${path}`;
    if (swaplow !== undefined) {
      command += ` ${swaplow}`;
    }
    if (swaplen !== undefined) {
      command += ` ${swaplen}`;
    }

    log.app.info('Executing swap add command', {
      command,
      path,
      pool: poolAssignment,
    });

    // Execute swap add command
    await execProm(command, { timeout: 30000 });

    // Remove verbose stderr logging - swap commands output to stderr even on success

    // Verify the swap area was added by checking swap -l
    const { stdout: verifyOutput } = await execProm('pfexec swap -l', { timeout: 10000 });
    const swapLines = verifyOutput.trim().split('\n').slice(1); // Skip header

    const addedArea = swapLines.find(line => line.includes(path));
    if (!addedArea) {
      return res.status(500).json({
        error: 'Swap area add command succeeded but area not found in swap list',
        details: 'The swap area may not have been added correctly',
      });
    }

    // Trigger immediate swap area collection to update database
    try {
      const SystemMetricsCollector = (await import('./SystemMetricsCollector.js')).default;
      const collector = new SystemMetricsCollector();
      await collector.collectSwapAreas();
    } catch (collectionError) {
      log.monitoring.warn('Failed to immediately update swap area data', {
        error: collectionError.message,
        path,
      });
    }

    return res.json({
      success: true,
      message: 'Swap area added successfully',
      path,
      poolAssignment,
      command,
      verification: addedArea,
    });
  } catch (error) {
    log.api.error('Error adding swap area', {
      error: error.message,
      stack: error.stack,
      path,
      poolAssignment,
    });
    return res.status(500).json({
      error: 'Failed to add swap area',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/swap/remove:
 *   delete:
 *     summary: Remove a swap area
 *     description: Removes a swap area with safety checks
 *     tags: [Swap Management]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - path
 *             properties:
 *               path:
 *                 type: string
 *                 description: Path to swap device/file to remove
 *                 example: "/dev/zvol/dsk/rpool/swap2"
 *               swaplow:
 *                 type: integer
 *                 description: Offset in 512-byte blocks (optional)
 *     responses:
 *       200:
 *         description: Swap area removed successfully
 *       400:
 *         description: Safety check failed or invalid request
 *       500:
 *         description: Failed to remove swap area
 */
export const removeSwapArea = async (req, res) => {
  const { path, swaplow } = req.body;

  try {
    if (!path) {
      return res.status(400).json({
        error: 'Path is required',
      });
    }

    // Safety check: ensure this isn't the last swap area
    const { stdout: swapListOutput } = await execProm('pfexec swap -l', { timeout: 10000 });
    const swapLines = swapListOutput.trim().split('\n').slice(1); // Skip header
    const activeSwapAreas = swapLines.filter(line => line.trim() !== '');

    if (activeSwapAreas.length <= 1) {
      return res.status(400).json({
        error: 'Cannot remove the last swap area',
        details: 'System must have at least one active swap area',
      });
    }

    // Check if the specific swap area exists
    const targetArea = activeSwapAreas.find(line => line.includes(path));
    if (!targetArea) {
      return res.status(400).json({
        error: 'Swap area not found',
        details: `No active swap area found with path: ${path}`,
      });
    }

    // Build swap remove command
    let command = `pfexec swap -d ${path}`;
    if (swaplow !== undefined) {
      command += ` ${swaplow}`;
    }

    log.app.info('Executing swap remove command', {
      command,
      path,
    });

    // Execute swap remove command
    await execProm(command, { timeout: 30000 });

    // Remove verbose stderr logging - swap commands output to stderr even on success

    // Verify the swap area was removed
    const { stdout: verifyOutput } = await execProm('pfexec swap -l', { timeout: 10000 });
    const remainingAreas = verifyOutput.trim().split('\n').slice(1);
    const stillExists = remainingAreas.find(line => line.includes(path));

    if (stillExists) {
      return res.status(500).json({
        error: 'Swap area remove command succeeded but area still exists',
        details: 'The swap area may still be in use or removal failed',
      });
    }

    // Update database to mark as inactive
    await SwapArea.update(
      { is_active: false },
      {
        where: {
          host: os.hostname(),
          path,
        },
      }
    );

    return res.json({
      success: true,
      message: 'Swap area removed successfully',
      path,
      command,
      remainingSwapAreas: remainingAreas.length,
    });
  } catch (error) {
    log.api.error('Error removing swap area', {
      error: error.message,
      stack: error.stack,
      path,
    });
    return res.status(500).json({
      error: 'Failed to remove swap area',
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
 *                       swap_total_gb:
 *                         type: string
 *                       swap_used_gb:
 *                         type: string
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
      swap_total_gb: record.swap_total_bytes
        ? (Number(record.swap_total_bytes) / 1024 ** 3).toFixed(2)
        : '0.00',
      swap_used_gb: record.swap_used_bytes
        ? (Number(record.swap_used_bytes) / 1024 ** 3).toFixed(2)
        : '0.00',
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
