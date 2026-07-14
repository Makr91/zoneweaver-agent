import { executeCommand } from '../../lib/CommandManager.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../../lib/Logger.js';

/**
 * @fileoverview ZFS snapshot hold controllers - hold, release, list holds
 */

/**
 * @swagger
 * /storage/snapshot/holds:
 *   post:
 *     summary: Hold ZFS snapshot
 *     description: Adds a hold tag to a snapshot (async task). The snapshot rides the `name` QUERY parameter, not the path (names have slashes).
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
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - tag
 *             properties:
 *               tag:
 *                 type: string
 *               recursive:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       202:
 *         description: Hold task created
 *       400:
 *         description: Invalid request
 *       404:
 *         description: Snapshot not found
 *       500:
 *         description: Failed to create task
 */
export const holdSnapshot = async (req, res) => {
  const { name: snapshot } = req.query;
  const { tag, recursive = false } = req.body;

  try {
    if (!snapshot) {
      return res.status(400).json({ error: 'Snapshot name is required' });
    }

    if (!tag) {
      return res.status(400).json({ error: 'Hold tag is required' });
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
      operation: 'zfs_hold_snapshot',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            snapshot,
            tag,
            recursive: recursive === 'true' || recursive === true,
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
      message: `Hold task created for ${snapshot} with tag ${tag}`,
      task_id: task.id,
      snapshot,
      tag,
    });
  } catch (error) {
    log.api.error('Error holding snapshot', {
      error: error.message,
      stack: error.stack,
      snapshot,
      tag,
    });
    return res.status(500).json({
      error: 'Failed to create hold task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/snapshot/holds:
 *   delete:
 *     summary: Release ZFS snapshot hold
 *     description: Removes a hold tag from a snapshot (async task). Snapshot and tag both ride QUERY parameters, not the path (snapshot names have slashes).
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
 *       - in: query
 *         name: tag
 *         required: true
 *         schema:
 *           type: string
 *         description: The hold tag to release
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               recursive:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       202:
 *         description: Release task created
 *       400:
 *         description: Invalid request
 *       404:
 *         description: Snapshot not found
 *       500:
 *         description: Failed to create task
 */
export const releaseSnapshot = async (req, res) => {
  const { name: snapshot, tag } = req.query;
  const { recursive = false } = req.body;

  try {
    if (!snapshot) {
      return res.status(400).json({ error: 'Snapshot name is required' });
    }

    if (!tag) {
      return res.status(400).json({ error: 'Hold tag is required' });
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
      operation: 'zfs_release_snapshot',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            snapshot,
            tag,
            recursive: recursive === 'true' || recursive === true,
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
      message: `Release task created for ${snapshot} tag ${tag}`,
      task_id: task.id,
      snapshot,
      tag,
    });
  } catch (error) {
    log.api.error('Error releasing snapshot hold', {
      error: error.message,
      stack: error.stack,
      snapshot,
      tag,
    });
    return res.status(500).json({
      error: 'Failed to create release task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/snapshot/holds:
 *   get:
 *     summary: List snapshot holds
 *     description: Lists holds on a specific snapshot. The snapshot rides the `name` QUERY parameter, not the path.
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
 *       - in: query
 *         name: recursive
 *         schema:
 *           type: boolean
 *           default: false
 *     responses:
 *       200:
 *         description: List of holds
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 snapshot:
 *                   type: string
 *                 holds:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       tag:
 *                         type: string
 *                       timestamp:
 *                         type: string
 *                 total:
 *                   type: integer
 *       400:
 *         description: Invalid snapshot name
 *       404:
 *         description: Snapshot not found
 *       500:
 *         description: Failed to list holds
 */
export const listHolds = async (req, res) => {
  const { name: snapshot, recursive = false } = req.query;

  try {
    if (!snapshot) {
      return res.status(400).json({ error: 'Snapshot name is required' });
    }

    if (!snapshot.includes('@')) {
      return res.status(400).json({ error: 'Snapshot must be in format dataset@snapshot' });
    }

    let command = `pfexec zfs holds -H`;

    if (recursive === 'true' || recursive === true) {
      command += ' -r';
    }

    command += ` ${snapshot}`;

    const result = await executeCommand(command);

    if (!result.success) {
      return res.status(404).json({
        error: `Snapshot ${snapshot} not found or has no holds`,
        details: result.error,
      });
    }

    const holds = result.output
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [name, tag, timestamp] = line.split('\t');
        return { name, tag, timestamp };
      });

    return res.json({
      snapshot,
      holds,
      total: holds.length,
    });
  } catch (error) {
    log.api.error('Error listing snapshot holds', {
      error: error.message,
      stack: error.stack,
      snapshot,
    });
    return res.status(500).json({
      error: 'Failed to list snapshot holds',
      details: error.message,
    });
  }
};
