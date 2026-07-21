import { executeCommand } from '../../lib/CommandManager.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { stringifyAsync } from '../../lib/AsyncJson.js';
import { log } from '../../lib/Logger.js';

/**
 * @fileoverview ZFS pool device controllers - replace, online, offline
 */

/**
 * @swagger
 * /storage/pools/{pool}/devices/replace:
 *   post:
 *     summary: Replace device in pool
 *     description: Replaces a device in a ZFS pool (async task)
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
 *               - old_device
 *               - new_device
 *             properties:
 *               old_device:
 *                 type: string
 *               new_device:
 *                 type: string
 *               force:
 *                 type: boolean
 *     responses:
 *       202:
 *         description: Replace device task created
 *       404:
 *         description: Pool not found
 */
export const replaceDevice = async (req, res) => {
  const { pool } = req.params;
  const { old_device, new_device, force = false } = req.body;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!old_device) {
      return res.status(400).json({ error: 'Old device is required' });
    }

    if (!new_device) {
      return res.status(400).json({ error: 'New device is required' });
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
      operation: 'zpool_replace_device',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        pool_name: pool,
        old_device,
        new_device,
        force: force === 'true' || force === true,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Replace device task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
      old_device,
      new_device,
    });
  } catch (error) {
    log.api.error('Error replacing device in pool', {
      error: error.message,
      stack: error.stack,
      pool,
      old_device,
      new_device,
    });
    return res.status(500).json({
      error: 'Failed to create replace device task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}/devices/online:
 *   post:
 *     summary: Online device in pool
 *     description: Brings a device online in a ZFS pool (async task)
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
 *               expand:
 *                 type: boolean
 *                 description: Expand device to use all available space
 *     responses:
 *       202:
 *         description: Online device task created
 *       404:
 *         description: Pool not found
 */
export const onlineDevice = async (req, res) => {
  const { pool } = req.params;
  const { device, expand = false } = req.body;

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
      operation: 'zpool_online_device',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        pool_name: pool,
        device,
        expand: expand === 'true' || expand === true,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Online device task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
      device,
    });
  } catch (error) {
    log.api.error('Error onlining device in pool', {
      error: error.message,
      stack: error.stack,
      pool,
      device,
    });
    return res.status(500).json({
      error: 'Failed to create online device task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}/devices/offline:
 *   post:
 *     summary: Offline device in pool
 *     description: Takes a device offline in a ZFS pool (async task)
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
 *               temporary:
 *                 type: boolean
 *                 description: Temporarily offline (will online on reboot)
 *     responses:
 *       202:
 *         description: Offline device task created
 *       404:
 *         description: Pool not found
 */
export const offlineDevice = async (req, res) => {
  const { pool } = req.params;
  const { device, temporary = false } = req.body;

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
      operation: 'zpool_offline_device',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        pool_name: pool,
        device,
        temporary: temporary === 'true' || temporary === true,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Offline device task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
      device,
    });
  } catch (error) {
    log.api.error('Error offlining device in pool', {
      error: error.message,
      stack: error.stack,
      pool,
      device,
    });
    return res.status(500).json({
      error: 'Failed to create offline device task',
      details: error.message,
    });
  }
};
