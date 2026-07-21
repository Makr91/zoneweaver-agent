/**
 * @fileoverview Boot environment activate, mount, and unmount operations
 */

import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/boot-environments/{name}/activate:
 *   post:
 *     summary: Activate boot environment
 *     description: Activate a boot environment for next boot
 *     tags: [Boot Environment Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the boot environment to activate
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               temporary:
 *                 type: boolean
 *                 default: false
 *                 description: Temporary activation (one-time boot)
 *     responses:
 *       202:
 *         description: Boot environment activation task created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 task_id:
 *                   type: string
 *                 be_name:
 *                   type: string
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create activation task
 */
export const activateBootEnvironment = async (req, res) => {
  try {
    const { name } = req.params;
    const { temporary = false } = req.body || {};

    if (!name) {
      return res.status(400).json({
        error: 'Boot environment name is required',
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'beadm_activate',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            temporary,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Boot environment activation task created for '${name}'${temporary ? ' (temporary)' : ''}`,
      task_id: task.id,
      be_name: name,
      temporary,
    });
  } catch (error) {
    log.api.error('Error creating boot environment activation task', {
      error: error.message,
      stack: error.stack,
      name: req.params.name,
      temporary: req.body?.temporary,
    });
    return res.status(500).json({
      error: 'Failed to create boot environment activation task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/boot-environments/{name}/mount:
 *   post:
 *     summary: Mount boot environment
 *     description: Mount a boot environment at specified location
 *     tags: [Boot Environment Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the boot environment to mount
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - mountpoint
 *             properties:
 *               mountpoint:
 *                 type: string
 *                 description: Directory to mount the BE at
 *               shared_mode:
 *                 type: string
 *                 enum: [ro, rw]
 *                 description: Mount shared filesystems as read-only or read-write
 *     responses:
 *       202:
 *         description: Boot environment mount task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create mount task
 */
export const mountBootEnvironment = async (req, res) => {
  try {
    const { name } = req.params;
    const { mountpoint, shared_mode } = req.body;

    if (!name) {
      return res.status(400).json({
        error: 'Boot environment name is required',
      });
    }

    if (!mountpoint) {
      return res.status(400).json({
        error: 'Mountpoint is required',
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'beadm_mount',
      priority: TaskPriority.LOW,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            mountpoint,
            shared_mode,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Boot environment mount task created for '${name}' at '${mountpoint}'`,
      task_id: task.id,
      be_name: name,
      mountpoint,
    });
  } catch (error) {
    log.api.error('Error creating boot environment mount task', {
      error: error.message,
      stack: error.stack,
      name: req.params.name,
      mountpoint: req.body?.mountpoint,
      shared_mode: req.body?.shared_mode,
    });
    return res.status(500).json({
      error: 'Failed to create boot environment mount task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/boot-environments/{name}/unmount:
 *   post:
 *     summary: Unmount boot environment
 *     description: Unmount a boot environment
 *     tags: [Boot Environment Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the boot environment to unmount
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               force:
 *                 type: boolean
 *                 default: false
 *                 description: Force unmount even if busy
 *     responses:
 *       202:
 *         description: Boot environment unmount task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create unmount task
 */
export const unmountBootEnvironment = async (req, res) => {
  try {
    const { name } = req.params;
    const { force = false } = req.body || {};

    if (!name) {
      return res.status(400).json({
        error: 'Boot environment name is required',
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'beadm_unmount',
      priority: TaskPriority.LOW,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            force,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Boot environment unmount task created for '${name}'`,
      task_id: task.id,
      be_name: name,
      force,
    });
  } catch (error) {
    log.api.error('Error creating boot environment unmount task', {
      error: error.message,
      stack: error.stack,
      name: req.params.name,
      force: req.body?.force,
    });
    return res.status(500).json({
      error: 'Failed to create boot environment unmount task',
      details: error.message,
    });
  }
};
