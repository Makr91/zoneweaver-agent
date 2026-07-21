import { executeCommand } from '../../lib/CommandManager.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { stringifyAsync } from '../../lib/AsyncJson.js';
import { log } from '../../lib/Logger.js';

/**
 * @fileoverview ZFS pool vdev controllers - add and remove vdevs
 */

/**
 * @swagger
 * /storage/pools/{pool}/vdevs:
 *   post:
 *     summary: Add vdev to pool
 *     description: Adds a new vdev to an existing ZFS pool (async task)
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
 *               - vdevs
 *             properties:
 *               vdevs:
 *                 type: array
 *               force:
 *                 type: boolean
 *     responses:
 *       202:
 *         description: Add vdev task created
 *       404:
 *         description: Pool not found
 */
export const addVdev = async (req, res) => {
  const { pool } = req.params;
  const { vdevs, force = false } = req.body;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!vdevs || !Array.isArray(vdevs) || vdevs.length === 0) {
      return res.status(400).json({ error: 'Vdevs array is required and must not be empty' });
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
      operation: 'zpool_add_vdev',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        pool_name: pool,
        vdevs,
        force: force === 'true' || force === true,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Add vdev task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
    });
  } catch (error) {
    log.api.error('Error adding vdev to pool', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to create add vdev task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}/vdevs/remove:
 *   post:
 *     summary: Remove vdev from pool
 *     description: Removes a device from a ZFS pool (async task)
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
 *               - device
 *             properties:
 *               device:
 *                 type: string
 *     responses:
 *       202:
 *         description: Remove vdev task created
 *       404:
 *         description: Pool not found
 */
export const removeVdev = async (req, res) => {
  const { pool } = req.params;
  const { device } = req.body;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!device) {
      return res.status(400).json({ error: 'Device is required' });
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
      operation: 'zpool_remove_vdev',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        pool_name: pool,
        device,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Remove vdev task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
      device,
    });
  } catch (error) {
    log.api.error('Error removing vdev from pool', {
      error: error.message,
      stack: error.stack,
      pool,
      device,
    });
    return res.status(500).json({
      error: 'Failed to create remove vdev task',
      details: error.message,
    });
  }
};
