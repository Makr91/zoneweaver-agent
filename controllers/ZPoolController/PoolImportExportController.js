import { executeCommand } from '../../lib/CommandManager.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../../lib/Logger.js';

/**
 * @fileoverview ZFS pool import/export controllers
 */

/**
 * @swagger
 * /storage/pools/{pool}/export:
 *   post:
 *     summary: Export ZFS pool
 *     description: Exports a ZFS pool from the system (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               force:
 *                 type: boolean
 *     responses:
 *       202:
 *         description: Export task created
 *       404:
 *         description: Pool not found
 */
export const exportPool = async (req, res) => {
  const { pool } = req.params;
  const { force = false } = req.body || {};

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    const result = await executeCommand(`pfexec zpool list ${pool}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Pool ${pool} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_export',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            pool_name: pool,
            force: force === 'true' || force === true,
          },
          (err, jsonResult) => {
            if (err) {
              reject(err);
            } else {
              resolve(jsonResult);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Export task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
    });
  } catch (error) {
    log.api.error('Error exporting pool', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to create export task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/import:
 *   post:
 *     summary: Import ZFS pool
 *     description: Imports a ZFS pool into the system (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               pool_name:
 *                 type: string
 *               pool_id:
 *                 type: string
 *               new_name:
 *                 type: string
 *               properties:
 *                 type: object
 *               force:
 *                 type: boolean
 *     responses:
 *       202:
 *         description: Import task created
 *       400:
 *         description: Invalid request
 */
export const importPool = async (req, res) => {
  const { pool_name, pool_id, new_name, properties = {}, force = false } = req.body;

  try {
    if (!pool_name && !pool_id) {
      return res.status(400).json({ error: 'Pool name or pool ID is required' });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_import',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            pool_name,
            pool_id,
            new_name,
            properties,
            force: force === 'true' || force === true,
          },
          (err, jsonResult) => {
            if (err) {
              reject(err);
            } else {
              resolve(jsonResult);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Import task created for pool ${pool_name || pool_id}`,
      task_id: task.id,
      pool_name: pool_name || pool_id,
    });
  } catch (error) {
    log.api.error('Error importing pool', {
      error: error.message,
      stack: error.stack,
      pool_name,
      pool_id,
    });
    return res.status(500).json({
      error: 'Failed to create import task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/importable:
 *   get:
 *     summary: List importable pools
 *     description: Lists ZFS pools available for import
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Importable pools listed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pools:
 *                   type: array
 *                   description: Pools available for import, structured (parsed from `zpool import`)
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string, example: "tank" }
 *                       id: { type: string, nullable: true, example: "1234567890123456789" }
 *                       state: { type: string, nullable: true, example: "ONLINE" }
 *                 total:
 *                   type: integer
 *                 output:
 *                   type: string
 *                   description: Raw `zpool import` output
 *                 message:
 *                   type: string
 *                   description: Present only when no pools are available for import
 */
export const listImportablePools = async (req, res) => {
  void req;
  try {
    const result = await executeCommand('pfexec zpool import');
    const output = result.output || '';

    const pools = [];
    for (const line of output.split('\n')) {
      const match = line.trim().match(/^(?<key>pool|id|state):\s*(?<value>\S+)$/u);
      if (!match) {
        continue;
      }
      if (match.groups.key === 'pool') {
        pools.push({ name: match.groups.value, id: null, state: null });
      } else if (pools.length > 0) {
        pools[pools.length - 1][match.groups.key] = match.groups.value;
      }
    }

    if (!result.success && !output) {
      return res.json({
        pools: [],
        total: 0,
        output: '',
        message: 'No pools available for import',
      });
    }

    return res.json({
      pools,
      total: pools.length,
      output,
    });
  } catch (error) {
    log.api.error('Error listing importable pools', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to list importable pools',
      details: error.message,
    });
  }
};
