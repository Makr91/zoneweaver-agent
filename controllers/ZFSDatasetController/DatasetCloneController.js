import { executeCommand } from '../../lib/CommandManager.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { stringifyAsync } from '../../lib/AsyncJson.js';
import { log } from '../../lib/Logger.js';

/**
 * @fileoverview ZFS dataset clone and promote controllers
 */

/**
 * @swagger
 * /storage/dataset/clone:
 *   post:
 *     summary: Clone ZFS snapshot
 *     description: Clones a snapshot to a new dataset (async task). The source snapshot rides the `name` QUERY parameter, not the path (names have slashes).
 *     tags: [ZFS Datasets]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Source snapshot (dataset@snapshot, e.g. Array-0/zones/web/boot@snap1)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - target
 *             properties:
 *               target:
 *                 type: string
 *                 description: Target dataset name
 *               properties:
 *                 type: object
 *     responses:
 *       202:
 *         description: Clone task created
 *       400:
 *         description: Invalid request
 *       404:
 *         description: Snapshot not found
 *       500:
 *         description: Failed to create task
 */
export const cloneDataset = async (req, res) => {
  const { name: snapshot } = req.query;
  const { target, properties = {} } = req.body;

  try {
    if (!snapshot) {
      return res.status(400).json({ error: 'Snapshot name is required' });
    }

    if (!target) {
      return res.status(400).json({ error: 'Target dataset name is required' });
    }

    if (!snapshot.includes('@')) {
      return res.status(400).json({ error: 'Snapshot must be in format dataset@snapshot' });
    }

    const result = await executeCommand(`pfexec zfs list -t snapshot ${snapshot}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Snapshot ${snapshot} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zfs_clone_dataset',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        snapshot,
        target,
        properties,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Clone task created from ${snapshot} to ${target}`,
      task_id: task.id,
      snapshot,
      target,
    });
  } catch (error) {
    log.api.error('Error cloning dataset', {
      error: error.message,
      stack: error.stack,
      snapshot,
      target,
    });
    return res.status(500).json({
      error: 'Failed to create clone task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/dataset/promote:
 *   post:
 *     summary: Promote ZFS clone
 *     description: Promotes a clone to an independent dataset (async task). The dataset name rides the `name` QUERY parameter, not the path.
 *     tags: [ZFS Datasets]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Dataset name (e.g. Array-0/zones/web/boot)
 *     responses:
 *       202:
 *         description: Promote task created
 *       404:
 *         description: Dataset not found
 *       500:
 *         description: Failed to create task
 */
export const promoteDataset = async (req, res) => {
  const { name } = req.query;

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
      operation: 'zfs_promote_dataset',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        name,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Promote task created for ${name}`,
      task_id: task.id,
      name,
    });
  } catch (error) {
    log.api.error('Error promoting dataset', {
      error: error.message,
      stack: error.stack,
      name,
    });
    return res.status(500).json({
      error: 'Failed to create promote task',
      details: error.message,
    });
  }
};
