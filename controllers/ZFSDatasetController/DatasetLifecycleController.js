import { executeCommand } from '../../lib/CommandManager.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../../lib/Logger.js';

/**
 * @fileoverview ZFS dataset lifecycle controllers - create, destroy, set properties
 */

/**
 * @swagger
 * /storage/datasets:
 *   post:
 *     summary: Create ZFS dataset
 *     description: Creates a new ZFS dataset or volume (async task)
 *     tags: [ZFS Datasets]
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
 *                 description: Dataset name
 *               type:
 *                 type: string
 *                 enum: [filesystem, volume]
 *                 default: filesystem
 *               properties:
 *                 type: object
 *                 description: ZFS properties to set
 *     responses:
 *       202:
 *         description: Dataset creation task created
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Failed to create task
 */
export const createDataset = async (req, res) => {
  const { name, type = 'filesystem', properties = {} } = req.body;

  try {
    if (!name) {
      return res.status(400).json({ error: 'Dataset name is required' });
    }

    if (!['filesystem', 'volume'].includes(type)) {
      return res.status(400).json({ error: 'Type must be filesystem or volume' });
    }

    if (type === 'volume' && !properties.volsize) {
      return res.status(400).json({ error: 'volsize is required for volumes' });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zfs_create_dataset',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            type,
            properties,
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
      message: `Dataset creation task created for ${name}`,
      task_id: task.id,
      name,
      type,
    });
  } catch (error) {
    log.api.error('Error creating dataset task', {
      error: error.message,
      stack: error.stack,
      name,
    });
    return res.status(500).json({
      error: 'Failed to create dataset task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/datasets/{name}:
 *   delete:
 *     summary: Destroy ZFS dataset
 *     description: Destroys a ZFS dataset (async task)
 *     tags: [ZFS Datasets]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               recursive:
 *                 type: boolean
 *                 default: false
 *               force:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       202:
 *         description: Destruction task created
 *       404:
 *         description: Dataset not found
 *       500:
 *         description: Failed to create task
 */
export const destroyDataset = async (req, res) => {
  const { name } = req.params;
  const { recursive = false, force = false } = req.body;

  try {
    if (!name) {
      return res.status(400).json({ error: 'Dataset name is required' });
    }

    const result = await executeCommand(`pfexec zfs list ${name}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Dataset ${name} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zfs_destroy_dataset',
      priority: TaskPriority.CRITICAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            recursive: recursive === 'true' || recursive === true,
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
      message: `Dataset destruction task created for ${name}`,
      task_id: task.id,
      name,
      recursive: recursive === 'true' || recursive === true,
      force: force === 'true' || force === true,
    });
  } catch (error) {
    log.api.error('Error destroying dataset', {
      error: error.message,
      stack: error.stack,
      name,
    });
    return res.status(500).json({
      error: 'Failed to create dataset destruction task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/datasets/{name}/properties:
 *   put:
 *     summary: Set dataset properties
 *     description: Updates ZFS properties for a dataset (async task)
 *     tags: [ZFS Datasets]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
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
 *         description: Dataset not found
 *       500:
 *         description: Failed to create task
 */
export const setDatasetProperties = async (req, res) => {
  const { name } = req.params;
  const { properties } = req.body;

  try {
    if (!name) {
      return res.status(400).json({ error: 'Dataset name is required' });
    }

    if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) {
      return res.status(400).json({ error: 'Properties object is required' });
    }

    const result = await executeCommand(`pfexec zfs list ${name}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Dataset ${name} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zfs_set_properties',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            properties,
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
      message: `Property update task created for ${name}`,
      task_id: task.id,
      name,
      properties,
    });
  } catch (error) {
    log.api.error('Error setting dataset properties', {
      error: error.message,
      stack: error.stack,
      name,
    });
    return res.status(500).json({
      error: 'Failed to create property update task',
      details: error.message,
    });
  }
};
