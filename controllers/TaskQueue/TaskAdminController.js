import Tasks from '../../models/TaskModel.js';
import { Op } from 'sequelize';
import config from '../../config/ConfigLoader.js';
import { log, createTimer } from '../../lib/Logger.js';
import { runningTasks, processorState } from './TaskState.js';

/**
 * @fileoverview Task admin controllers - cancel, stats, cleanup
 */

/**
 * @swagger
 * /tasks/{taskId}:
 *   delete:
 *     summary: Cancel task
 *     description: Cancels a pending task (cannot cancel running tasks)
 *     tags: [Task Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema:
 *           type: string
 *         description: Task ID to cancel
 *     responses:
 *       200:
 *         description: Task cancelled successfully
 *       400:
 *         description: Task cannot be cancelled
 *       404:
 *         description: Task not found
 */
export const cancelTask = async (req, res) => {
  try {
    const { taskId } = req.params;

    const task = await Tasks.findByPk(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (task.status !== 'pending') {
      return res.status(400).json({
        error: 'Can only cancel pending tasks',
        current_status: task.status,
      });
    }

    await task.update({ status: 'cancelled' });

    return res.json({
      success: true,
      task_id: taskId,
      message: 'Task cancelled successfully',
    });
  } catch (error) {
    log.database.error('Database error cancelling task', {
      error: error.message,
      stack: error.stack,
      task_id: req.params.taskId,
    });
    return res.status(500).json({ error: 'Failed to cancel task' });
  }
};

/**
 * @swagger
 * /tasks/stats:
 *   get:
 *     summary: Get task queue statistics
 *     description: Retrieves statistics about the task queue
 *     tags: [Task Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Task statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pending_tasks:
 *                   type: integer
 *                 running_tasks:
 *                   type: integer
 *                 completed_tasks:
 *                   type: integer
 *                 failed_tasks:
 *                   type: integer
 *                 cancelled_tasks:
 *                   type: integer
 *                 max_concurrent_tasks:
 *                   type: integer
 *                 task_processor_running:
 *                   type: boolean
 */
export const getTaskStats = async (req, res) => {
  void req;
  try {
    const stats = await Tasks.findAll({
      attributes: ['status', [Tasks.sequelize.fn('COUNT', '*'), 'count']],
      group: ['status'],
    });

    const statMap = stats.reduce((acc, stat) => {
      acc[stat.status] = parseInt(stat.dataValues.count);
      return acc;
    }, {});

    res.json({
      pending_tasks: statMap.pending || 0,
      running_tasks: runningTasks.size,
      completed_tasks: statMap.completed || 0,
      failed_tasks: statMap.failed || 0,
      cancelled_tasks: statMap.cancelled || 0,
      max_concurrent_tasks: config.getZones().max_concurrent_tasks || 5,
      task_processor_running: processorState.taskProcessor !== null,
    });
  } catch (error) {
    log.database.error('Database error getting task stats', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to retrieve task statistics' });
  }
};

/**
 * @swagger
 * /tasks/completed:
 *   delete:
 *     summary: Clear completed tasks
 *     description: |
 *       Hard-deletes all completed, failed, and cancelled tasks from the database immediately.
 *       Running and pending tasks are not affected.
 *     tags: [Task Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Completed tasks cleared successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 deleted_count:
 *                   type: integer
 *                   description: Number of tasks deleted
 *       500:
 *         description: Failed to clear completed tasks
 */
export const clearCompletedTasks = async (req, res) => {
  try {
    const deleted = await Tasks.destroy({
      where: {
        status: { [Op.in]: ['completed', 'failed', 'cancelled'] },
      },
    });

    log.database.info('Completed tasks cleared', {
      triggered_by: req.entity.name,
      deleted_count: deleted,
    });

    return res.json({
      success: true,
      message: `Deleted ${deleted} completed/failed/cancelled tasks`,
      deleted_count: deleted,
    });
  } catch (error) {
    log.database.error('Error clearing completed tasks', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to clear completed tasks' });
  }
};

/**
 * Clean up old tasks based on retention policies
 * @description Removes completed, failed, and cancelled tasks older than the configured retention period
 */
export const cleanupOldTasks = async () => {
  const timer = createTimer('cleanup old tasks');
  try {
    const hostMonitoringConfig = config.getHostMonitoring();
    const retentionConfig = hostMonitoringConfig.retention;
    const now = new Date();

    // Clean up completed, failed, and cancelled tasks
    const tasksRetentionDate = new Date(
      now.getTime() - retentionConfig.tasks * 24 * 60 * 60 * 1000
    );
    const deletedTasks = await Tasks.destroy({
      where: {
        status: { [Op.in]: ['completed', 'failed', 'cancelled'] },
        created_at: { [Op.lt]: tasksRetentionDate },
      },
    });

    const duration = timer.end();

    if (deletedTasks > 0) {
      log.database.info('Tasks cleanup completed', {
        deleted_count: deletedTasks,
        retention_days: retentionConfig.tasks,
        duration_ms: duration,
      });
    }
  } catch (error) {
    timer.end();
    log.database.error('Failed to cleanup old tasks', {
      error: error.message,
      stack: error.stack,
    });
  }
};
