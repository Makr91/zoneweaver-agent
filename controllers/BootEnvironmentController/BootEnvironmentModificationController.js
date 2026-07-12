/**
 * @fileoverview Boot environment modification operations
 */

import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/boot-environments:
 *   post:
 *     summary: Create boot environment
 *     description: Create a new boot environment
 *     tags: [Boot Environment Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 description: Name for the new boot environment
 *               description:
 *                 type: string
 *                 description: Description for the boot environment
 *               source_be:
 *                 type: string
 *                 description: Source boot environment to clone from
 *               snapshot:
 *                 type: string
 *                 description: Snapshot to create BE from (format -- be@snapshot)
 *               activate:
 *                 type: boolean
 *                 default: false
 *                 description: Activate the new boot environment
 *               zpool:
 *                 type: string
 *                 description: ZFS pool to create the BE in
 *               properties:
 *                 type: object
 *                 description: ZFS properties to set
 *     responses:
 *       202:
 *         description: Boot environment creation task created successfully
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
 *         description: Failed to create boot environment task
 */
export const createBootEnvironment = async (req, res) => {
  try {
    const {
      name,
      description,
      source_be,
      snapshot,
      activate = false,
      zpool,
      properties = {},
    } = req.body;

    if (!name) {
      return res.status(400).json({
        error: 'Boot environment name is required',
      });
    }

    // Validate name (basic validation)
    if (!/^[a-zA-Z0-9\-_.]+$/.test(name)) {
      return res.status(400).json({
        error: 'Boot environment name contains invalid characters',
      });
    }

    // Create task for boot environment creation
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'beadm_create',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            description,
            source_be,
            snapshot,
            activate,
            zpool,
            properties,
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
      message: `Boot environment creation task created for '${name}'`,
      task_id: task.id,
      be_name: name,
      activate,
    });
  } catch (error) {
    log.api.error('Error creating boot environment task', {
      error: error.message,
      stack: error.stack,
      name: req.body?.name,
      activate: req.body?.activate,
    });
    return res.status(500).json({
      error: 'Failed to create boot environment task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/boot-environments/{name}:
 *   delete:
 *     summary: Delete boot environment
 *     description: Delete a boot environment
 *     tags: [Boot Environment Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the boot environment to delete
 *       - in: query
 *         name: force
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Force deletion
 *       - in: query
 *         name: snapshots
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Delete all snapshots as well
 *     responses:
 *       202:
 *         description: Boot environment deletion task created successfully
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
 *         description: Failed to create deletion task
 */
export const deleteBootEnvironment = async (req, res) => {
  try {
    const { name } = req.params;
    const { force = false, snapshots = false } = req.query;

    if (!name) {
      return res.status(400).json({
        error: 'Boot environment name is required',
      });
    }

    // Create task for boot environment deletion
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'beadm_delete',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            force: force === 'true' || force === true,
            snapshots: snapshots === 'true' || snapshots === true,
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
      message: `Boot environment deletion task created for '${name}'`,
      task_id: task.id,
      be_name: name,
      force: force === 'true' || force === true,
      snapshots: snapshots === 'true' || snapshots === true,
    });
  } catch (error) {
    log.api.error('Error creating boot environment deletion task', {
      error: error.message,
      stack: error.stack,
      name: req.params.name,
      force: req.query.force,
      snapshots: req.query.snapshots,
    });
    return res.status(500).json({
      error: 'Failed to create boot environment deletion task',
      details: error.message,
    });
  }
};

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

    // Create task for boot environment activation
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

    // Create task for boot environment mounting
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

    // Create task for boot environment unmounting
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
