/**
 * @fileoverview Swap Modification Controller for Zoneweaver Agent
 * @description Provides API endpoints for swap area management on OmniOS systems
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import os from 'os';
import SwapArea from '../../models/SwapAreaModel.js';
import { log } from '../../lib/Logger.js';

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
      const SystemMetricsCollector = (await import('../SystemMetricsCollector.js')).default;
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

    // Drop the row — the table only holds current swap areas
    await SwapArea.destroy({
      where: {
        host: os.hostname(),
        swapfile: path,
      },
    });

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
