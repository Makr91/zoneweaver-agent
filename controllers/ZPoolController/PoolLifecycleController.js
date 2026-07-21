import { executeCommand } from '../../lib/CommandManager.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { stringifyAsync } from '../../lib/AsyncJson.js';
import { log } from '../../lib/Logger.js';

/**
 * @fileoverview ZFS pool lifecycle controllers - create, destroy, set properties
 */

/**
 * @swagger
 * /storage/pools:
 *   post:
 *     summary: Create ZFS pool
 *     description: Creates a new ZFS storage pool (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - pool_name
 *               - vdevs
 *             properties:
 *               pool_name:
 *                 type: string
 *               vdevs:
 *                 type: array
 *                 description: Array of vdev specs (strings or {type, devices} objects)
 *               properties:
 *                 type: object
 *               force:
 *                 type: boolean
 *               mount_point:
 *                 type: string
 *     responses:
 *       202:
 *         description: Pool creation task created
 *       400:
 *         description: Invalid request
 */
export const createPool = async (req, res) => {
  const { pool_name, vdevs, properties = {}, force = false, mount_point } = req.body;

  try {
    if (!pool_name) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!vdevs || !Array.isArray(vdevs) || vdevs.length === 0) {
      return res.status(400).json({ error: 'Vdevs array is required and must not be empty' });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_create',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        pool_name,
        vdevs,
        properties,
        force: force === 'true' || force === true,
        mount_point,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Pool creation task created for ${pool_name}`,
      task_id: task.id,
      pool_name,
    });
  } catch (error) {
    log.api.error('Error creating pool task', {
      error: error.message,
      stack: error.stack,
      pool_name,
    });
    return res.status(500).json({
      error: 'Failed to create pool task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}:
 *   delete:
 *     summary: Destroy ZFS pool
 *     description: Destroys a ZFS storage pool (async task)
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
 *         description: Pool destruction task created
 *       404:
 *         description: Pool not found
 */
export const destroyPool = async (req, res) => {
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
      operation: 'zpool_destroy',
      priority: TaskPriority.CRITICAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        pool_name: pool,
        force: force === 'true' || force === true,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Pool destruction task created for ${pool}`,
      task_id: task.id,
      pool_name: pool,
    });
  } catch (error) {
    log.api.error('Error destroying pool', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to create pool destruction task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}/properties:
 *   put:
 *     summary: Set pool properties
 *     description: Updates properties on a ZFS pool (async task)
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
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - properties
 *             properties:
 *               properties:
 *                 type: object
 *     responses:
 *       202:
 *         description: Property update task created
 *       404:
 *         description: Pool not found
 */
export const setPoolProperties = async (req, res) => {
  const { pool } = req.params;
  const { properties } = req.body;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) {
      return res.status(400).json({ error: 'Properties object is required' });
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
      operation: 'zpool_set_properties',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        pool_name: pool,
        properties,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Property update task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
      properties,
    });
  } catch (error) {
    log.api.error('Error setting pool properties', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to create property update task',
      details: error.message,
    });
  }
};
