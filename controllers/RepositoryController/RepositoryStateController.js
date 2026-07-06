/**
 * @fileoverview Repository state operations (enable, disable)
 */

import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/repositories/{name}/enable:
 *   post:
 *     summary: Enable package repository
 *     description: Enable a package repository (publisher)
 *     tags: [Repository Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the publisher to enable
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this task
 *     responses:
 *       202:
 *         description: Repository enable task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create enable task
 */
export const enableRepository = async (req, res) => {
  const { name } = req.params;
  const { created_by = 'api' } = req.body || {};

  try {
    if (!name) {
      return res.status(400).json({
        error: 'Publisher name is required',
      });
    }

    // Create task for repository enabling
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'repository_enable',
      priority: TaskPriority.LOW,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
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
      message: `Repository enable task created for publisher '${name}'`,
      task_id: task.id,
      publisher_name: name,
    });
  } catch (error) {
    log.api.error('Error creating repository enable task', {
      error: error.message,
      stack: error.stack,
      name,
      created_by,
    });
    return res.status(500).json({
      error: 'Failed to create repository enable task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/repositories/{name}/disable:
 *   post:
 *     summary: Disable package repository
 *     description: Disable a package repository (publisher)
 *     tags: [Repository Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the publisher to disable
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this task
 *     responses:
 *       202:
 *         description: Repository disable task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create disable task
 */
export const disableRepository = async (req, res) => {
  const { name } = req.params;
  const { created_by = 'api' } = req.body || {};

  try {
    if (!name) {
      return res.status(400).json({
        error: 'Publisher name is required',
      });
    }

    // Create task for repository disabling
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'repository_disable',
      priority: TaskPriority.LOW,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
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
      message: `Repository disable task created for publisher '${name}'`,
      task_id: task.id,
      publisher_name: name,
    });
  } catch (error) {
    log.api.error('Error creating repository disable task', {
      error: error.message,
      stack: error.stack,
      name,
      created_by,
    });
    return res.status(500).json({
      error: 'Failed to create repository disable task',
      details: error.message,
    });
  }
};
