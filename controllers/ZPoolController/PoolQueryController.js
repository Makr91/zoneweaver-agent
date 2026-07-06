import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';

/**
 * @fileoverview ZFS pool query controllers - list, details, status
 */

/**
 * @swagger
 * /storage/pools:
 *   get:
 *     summary: List ZFS pools
 *     description: Retrieves a list of all ZFS storage pools
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Pools retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pools:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       size:
 *                         type: string
 *                       alloc:
 *                         type: string
 *                       free:
 *                         type: string
 *                       capacity_percent:
 *                         type: string
 *                       dedup_ratio:
 *                         type: string
 *                       health:
 *                         type: string
 *                       altroot:
 *                         type: string
 *                         nullable: true
 *                 total:
 *                   type: integer
 */
export const listPools = async (req, res) => {
  void req;
  try {
    const result = await executeCommand(
      'pfexec zpool list -H -p -o name,size,alloc,free,cap,dedup,health,altroot'
    );

    if (!result.success) {
      return res.status(500).json({
        error: 'Failed to list pools',
        details: result.error,
      });
    }

    const pools = result.output
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [name, size, alloc, free, cap, dedup, health, altroot] = line.split('\t');
        return {
          name,
          size,
          alloc,
          free,
          capacity_percent: cap,
          dedup_ratio: dedup,
          health,
          altroot: altroot === '-' ? null : altroot,
        };
      });

    return res.json({
      pools,
      total: pools.length,
    });
  } catch (error) {
    log.api.error('Error listing pools', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to list pools',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}:
 *   get:
 *     summary: Get pool details
 *     description: Retrieves all properties for a specific ZFS pool
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool name
 *     responses:
 *       200:
 *         description: Pool details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 properties:
 *                   type: object
 *                   description: Map of zpool property name to { value, source }
 *                   additionalProperties:
 *                     type: object
 *                     properties:
 *                       value:
 *                         type: string
 *                       source:
 *                         type: string
 *       404:
 *         description: Pool not found
 */
export const getPoolDetails = async (req, res) => {
  const { pool } = req.params;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    const result = await executeCommand(`pfexec zpool get all -H -p ${pool}`);

    if (!result.success) {
      return res.status(404).json({
        error: 'Pool not found',
        details: result.error,
      });
    }

    const properties = {};
    result.output.split('\n').forEach(line => {
      const parts = line.split('\t');
      if (parts.length >= 4) {
        const [, prop, value, source] = parts;
        properties[prop] = { value, source };
      }
    });

    return res.json({
      name: pool,
      properties,
    });
  } catch (error) {
    log.api.error('Error getting pool details', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to get pool details',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}/status:
 *   get:
 *     summary: Get pool status
 *     description: Retrieves detailed status information for a ZFS pool including vdev tree and scan status
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool name
 *     responses:
 *       200:
 *         description: Pool status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 status:
 *                   type: string
 *                   description: Raw `zpool status` output (vdev tree, scan status, errors)
 *       404:
 *         description: Pool not found
 */
export const getPoolStatus = async (req, res) => {
  const { pool } = req.params;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    const result = await executeCommand(`pfexec zpool status ${pool}`);

    if (!result.success) {
      return res.status(404).json({
        error: 'Pool not found',
        details: result.error,
      });
    }

    return res.json({
      name: pool,
      status: result.output,
    });
  } catch (error) {
    log.api.error('Error getting pool status', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to get pool status',
      details: error.message,
    });
  }
};
