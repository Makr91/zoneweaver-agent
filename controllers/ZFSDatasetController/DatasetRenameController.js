import { executeCommand } from '../../lib/CommandManager.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../../lib/Logger.js';

/**
 * @fileoverview ZFS dataset rename controller
 */

/**
 * @swagger
 * /storage/dataset/rename:
 *   post:
 *     summary: Rename ZFS dataset
 *     description: Renames a ZFS dataset (async task). The dataset name rides the `name` QUERY parameter, not the path.
 *     tags: [ZFS Datasets]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Current dataset name (e.g. Array-0/zones/web/data)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - new_name
 *             properties:
 *               new_name:
 *                 type: string
 *               recursive:
 *                 type: boolean
 *                 default: false
 *               force:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       202:
 *         description: Rename task created
 *       400:
 *         description: Invalid request
 *       404:
 *         description: Dataset not found
 *       500:
 *         description: Failed to create task
 */
export const renameDataset = async (req, res) => {
  const { name } = req.query;
  const { new_name, recursive = false, force = false } = req.body;

  try {
    if (!name) {
      return res.status(400).json({ error: 'Dataset name is required' });
    }

    if (!new_name) {
      return res.status(400).json({ error: 'New name is required' });
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
      operation: 'zfs_rename_dataset',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            new_name,
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
      message: `Rename task created from ${name} to ${new_name}`,
      task_id: task.id,
      name,
      new_name,
    });
  } catch (error) {
    log.api.error('Error renaming dataset', {
      error: error.message,
      stack: error.stack,
      name,
      new_name,
    });
    return res.status(500).json({
      error: 'Failed to create rename task',
      details: error.message,
    });
  }
};
