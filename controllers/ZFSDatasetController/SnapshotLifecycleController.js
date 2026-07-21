import { executeCommand } from '../../lib/CommandManager.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { stringifyAsync } from '../../lib/AsyncJson.js';
import { log } from '../../lib/Logger.js';

/**
 * @fileoverview ZFS snapshot lifecycle controllers - create, destroy, rollback
 */

/**
 * @swagger
 * /storage/dataset/snapshots:
 *   post:
 *     summary: Create ZFS snapshot
 *     description: Creates a snapshot of a dataset (async task). The dataset name rides the `name` QUERY parameter, not the path (dataset names have slashes).
 *     tags: [ZFS Snapshots]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Dataset name (e.g. Array-0/zones/web/data)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - snapshot_name
 *             properties:
 *               snapshot_name:
 *                 type: string
 *               recursive:
 *                 type: boolean
 *                 default: false
 *               properties:
 *                 type: object
 *     responses:
 *       202:
 *         description: Snapshot task created
 *       400:
 *         description: Invalid request
 *       404:
 *         description: Dataset not found
 *       500:
 *         description: Failed to create task
 */
export const createSnapshot = async (req, res) => {
  const { name } = req.query;
  const { snapshot_name, recursive = false, properties = {} } = req.body;

  try {
    if (!name) {
      return res.status(400).json({ error: 'Dataset name is required' });
    }

    if (!snapshot_name) {
      return res.status(400).json({ error: 'Snapshot name is required' });
    }

    const fullSnapshotName = `${name}@${snapshot_name}`;

    const result = await executeCommand(`pfexec zfs list ${name}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Dataset ${name} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zfs_create_snapshot',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        name: fullSnapshotName,
        recursive: recursive === 'true' || recursive === true,
        properties,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Snapshot creation task created for ${fullSnapshotName}`,
      task_id: task.id,
      snapshot: fullSnapshotName,
    });
  } catch (error) {
    log.api.error('Error creating snapshot', {
      error: error.message,
      stack: error.stack,
      name,
      snapshot_name,
    });
    return res.status(500).json({
      error: 'Failed to create snapshot task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/snapshot:
 *   delete:
 *     summary: Destroy ZFS snapshot
 *     description: Destroys a ZFS snapshot (async task). The snapshot rides the `name` QUERY parameter, not the path (names have slashes).
 *     tags: [ZFS Snapshots]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Snapshot (dataset@snapshot, e.g. Array-0/zones/web/boot@snap1)
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               recursive:
 *                 type: boolean
 *                 default: false
 *               defer:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       202:
 *         description: Destruction task created
 *       400:
 *         description: Invalid snapshot name
 *       404:
 *         description: Snapshot not found
 *       500:
 *         description: Failed to create task
 */
export const destroySnapshot = async (req, res) => {
  const { name: snapshot } = req.query;
  const { recursive = false, defer = false } = req.body;

  try {
    if (!snapshot) {
      return res.status(400).json({ error: 'Snapshot name is required' });
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
      operation: 'zfs_destroy_snapshot',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        snapshot,
        recursive: recursive === 'true' || recursive === true,
        defer: defer === 'true' || defer === true,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Snapshot destruction task created for ${snapshot}`,
      task_id: task.id,
      snapshot,
    });
  } catch (error) {
    log.api.error('Error destroying snapshot', {
      error: error.message,
      stack: error.stack,
      snapshot,
    });
    return res.status(500).json({
      error: 'Failed to create snapshot destruction task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/snapshot/rollback:
 *   post:
 *     summary: Rollback ZFS snapshot
 *     description: Rolls back a dataset to a previous snapshot (async task). The snapshot rides the `name` QUERY parameter, not the path.
 *     tags: [ZFS Snapshots]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Snapshot (dataset@snapshot, e.g. Array-0/zones/web/boot@snap1)
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
 *         description: Rollback task created
 *       400:
 *         description: Invalid snapshot name
 *       404:
 *         description: Snapshot not found
 *       500:
 *         description: Failed to create task
 */
export const rollbackSnapshot = async (req, res) => {
  const { name: snapshot } = req.query;
  const { recursive = false, force = false } = req.body;

  try {
    if (!snapshot) {
      return res.status(400).json({ error: 'Snapshot name is required' });
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
      operation: 'zfs_rollback_snapshot',
      priority: TaskPriority.CRITICAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        snapshot,
        recursive: recursive === 'true' || recursive === true,
        force: force === 'true' || force === true,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Rollback task created for ${snapshot}`,
      task_id: task.id,
      snapshot,
    });
  } catch (error) {
    log.api.error('Error rolling back snapshot', {
      error: error.message,
      stack: error.stack,
      snapshot,
    });
    return res.status(500).json({
      error: 'Failed to create rollback task',
      details: error.message,
    });
  }
};
