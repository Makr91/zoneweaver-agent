import { executeCommand } from '../../lib/CommandManager.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { stringifyAsync } from '../../lib/AsyncJson.js';
import { log } from '../../lib/Logger.js';

/**
 * @fileoverview ZFS pool upgrade controller
 */

/**
 * @swagger
 * /storage/pools/{pool}/upgrade:
 *   post:
 *     summary: Upgrade ZFS pool
 *     description: Upgrades a ZFS pool to the latest supported version (async task)
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
 *         description: Upgrade task created
 *       404:
 *         description: Pool not found
 */
export const upgradePool = async (req, res) => {
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
      operation: 'zpool_upgrade',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        pool_name: pool,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Upgrade task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
    });
  } catch (error) {
    log.api.error('Error upgrading pool', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to create upgrade task',
      details: error.message,
    });
  }
};
