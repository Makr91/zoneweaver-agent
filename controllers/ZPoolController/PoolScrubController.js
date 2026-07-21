import { executeCommand } from '../../lib/CommandManager.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { stringifyAsync } from '../../lib/AsyncJson.js';
import { log } from '../../lib/Logger.js';

/**
 * @fileoverview ZFS pool scrub controllers - start and stop scrub
 */

/**
 * @swagger
 * /storage/pools/{pool}/scrub:
 *   post:
 *     summary: Start pool scrub
 *     description: Starts a scrub operation on a ZFS pool (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       202:
 *         description: Scrub task created
 *       404:
 *         description: Pool not found
 */
export const scrubPool = async (req, res) => {
  const { pool } = req.params;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    const result = await executeCommand(`pfexec zpool list ${pool}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Pool ${pool} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_scrub',
      priority: TaskPriority.LOW,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        pool_name: pool,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Scrub task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
    });
  } catch (error) {
    log.api.error('Error starting pool scrub', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to create scrub task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}/scrub/stop:
 *   post:
 *     summary: Stop pool scrub
 *     description: Stops an in-progress scrub on a ZFS pool (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       202:
 *         description: Stop scrub task created
 *       404:
 *         description: Pool not found
 */
export const stopScrub = async (req, res) => {
  const { pool } = req.params;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    const result = await executeCommand(`pfexec zpool list ${pool}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Pool ${pool} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_stop_scrub',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        pool_name: pool,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Stop scrub task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
    });
  } catch (error) {
    log.api.error('Error stopping pool scrub', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to create stop scrub task',
      details: error.message,
    });
  }
};
