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

    if (!/^[a-zA-Z0-9\-_.]+$/.test(name)) {
      return res.status(400).json({
        error: 'Boot environment name contains invalid characters',
      });
    }

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
