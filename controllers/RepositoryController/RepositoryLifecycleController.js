/**
 * @fileoverview Repository lifecycle operations (add, remove, modify)
 */

import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/repositories:
 *   post:
 *     summary: Add package repository
 *     description: Add a new package repository (publisher)
 *     tags: [Repository Management]
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
 *               - origin
 *             properties:
 *               name:
 *                 type: string
 *                 description: Publisher name
 *               origin:
 *                 type: string
 *                 description: Repository origin URI
 *               mirrors:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Mirror URIs
 *               ssl_cert:
 *                 type: string
 *                 description: Path to SSL certificate
 *               ssl_key:
 *                 type: string
 *                 description: Path to SSL key
 *               enabled:
 *                 type: boolean
 *                 default: true
 *                 description: Enable the publisher
 *               sticky:
 *                 type: boolean
 *                 default: true
 *                 description: Make the publisher sticky
 *               search_first:
 *                 type: boolean
 *                 default: false
 *                 description: Set as first in search order
 *               search_before:
 *                 type: string
 *                 description: Position before this publisher in search order
 *               search_after:
 *                 type: string
 *                 description: Position after this publisher in search order
 *               properties:
 *                 type: object
 *                 description: Publisher properties to set
 *               proxy:
 *                 type: string
 *                 description: Proxy URI for this publisher
 *     responses:
 *       202:
 *         description: Repository addition task created successfully
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
 *                 publisher_name:
 *                   type: string
 *                 origin:
 *                   type: string
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create repository addition task
 */
export const addRepository = async (req, res) => {
  const {
    name,
    origin,
    mirrors = [],
    ssl_cert,
    ssl_key,
    enabled = true,
    sticky = true,
    search_first = false,
    search_before,
    search_after,
    properties = {},
    proxy,
  } = req.body;

  try {
    if (!name) {
      return res.status(400).json({
        error: 'Publisher name is required',
      });
    }

    if (!origin) {
      return res.status(400).json({
        error: 'Origin URI is required',
      });
    }

    // Validate name (basic validation)
    if (!/^[a-zA-Z0-9\-_.]+$/.test(name)) {
      return res.status(400).json({
        error: 'Publisher name contains invalid characters',
      });
    }

    // Create task for repository addition
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'repository_add',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            origin,
            mirrors,
            ssl_cert,
            ssl_key,
            enabled,
            sticky,
            search_first,
            search_before,
            search_after,
            properties,
            proxy,
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
      message: `Repository addition task created for publisher '${name}'`,
      task_id: task.id,
      publisher_name: name,
      origin,
    });
  } catch (error) {
    log.api.error('Error creating repository addition task', {
      error: error.message,
      stack: error.stack,
      name,
      origin,
    });
    return res.status(500).json({
      error: 'Failed to create repository addition task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/repositories/{name}:
 *   delete:
 *     summary: Remove package repository
 *     description: Remove a package repository (publisher)
 *     tags: [Repository Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the publisher to remove
 *     responses:
 *       202:
 *         description: Repository removal task created successfully
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
 *                 publisher_name:
 *                   type: string
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create removal task
 */
export const removeRepository = async (req, res) => {
  const { name } = req.params;

  try {
    if (!name) {
      return res.status(400).json({
        error: 'Publisher name is required',
      });
    }

    // Create task for repository removal
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'repository_remove',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
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
      message: `Repository removal task created for publisher '${name}'`,
      task_id: task.id,
      publisher_name: name,
    });
  } catch (error) {
    log.api.error('Error creating repository removal task', {
      error: error.message,
      stack: error.stack,
      name,
    });
    return res.status(500).json({
      error: 'Failed to create repository removal task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/repositories/{name}:
 *   put:
 *     summary: Modify package repository
 *     description: Modify an existing package repository (publisher)
 *     tags: [Repository Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the publisher to modify
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               origins_to_add:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Origin URIs to add
 *               origins_to_remove:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Origin URIs to remove
 *               mirrors_to_add:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Mirror URIs to add
 *               mirrors_to_remove:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Mirror URIs to remove
 *               ssl_cert:
 *                 type: string
 *                 description: Path to SSL certificate
 *               ssl_key:
 *                 type: string
 *                 description: Path to SSL key
 *               enabled:
 *                 type: boolean
 *                 description: Enable/disable the publisher
 *               sticky:
 *                 type: boolean
 *                 description: Make the publisher sticky/non-sticky
 *               search_first:
 *                 type: boolean
 *                 description: Set as first in search order
 *               search_before:
 *                 type: string
 *                 description: Position before this publisher in search order
 *               search_after:
 *                 type: string
 *                 description: Position after this publisher in search order
 *               properties_to_set:
 *                 type: object
 *                 description: Publisher properties to set
 *               properties_to_unset:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Publisher properties to unset
 *               proxy:
 *                 type: string
 *                 description: Proxy URI for this publisher
 *               reset_uuid:
 *                 type: boolean
 *                 default: false
 *                 description: Generate new UUID for this image
 *               refresh:
 *                 type: boolean
 *                 default: false
 *                 description: Refresh publisher metadata after modification
 *     responses:
 *       202:
 *         description: Repository modification task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create modification task
 */
export const modifyRepository = async (req, res) => {
  const { name } = req.params;
  const {
    origins_to_add = [],
    origins_to_remove = [],
    mirrors_to_add = [],
    mirrors_to_remove = [],
    ssl_cert,
    ssl_key,
    enabled,
    sticky,
    search_first,
    search_before,
    search_after,
    properties_to_set = {},
    properties_to_unset = [],
    proxy,
    reset_uuid = false,
    refresh = false,
  } = req.body;

  try {
    if (!name) {
      return res.status(400).json({
        error: 'Publisher name is required',
      });
    }

    // Create task for repository modification
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'repository_modify',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            origins_to_add,
            origins_to_remove,
            mirrors_to_add,
            mirrors_to_remove,
            ssl_cert,
            ssl_key,
            enabled,
            sticky,
            search_first,
            search_before,
            search_after,
            properties_to_set,
            properties_to_unset,
            proxy,
            reset_uuid,
            refresh,
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
      message: `Repository modification task created for publisher '${name}'`,
      task_id: task.id,
      publisher_name: name,
    });
  } catch (error) {
    log.api.error('Error creating repository modification task', {
      error: error.message,
      stack: error.stack,
      name,
    });
    return res.status(500).json({
      error: 'Failed to create repository modification task',
      details: error.message,
    });
  }
};
