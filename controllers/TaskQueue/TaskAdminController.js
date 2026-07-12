import Tasks from '../../models/TaskModel.js';
import { Op } from 'sequelize';
import config from '../../config/ConfigLoader.js';
import { log, createTimer } from '../../lib/Logger.js';
import { runningTasks, processorState } from './TaskState.js';
import { cancelTaskById } from './TaskLifecycle.js';

/**
 * @fileoverview Task admin controllers - cancel, stats, cleanup
 */

/**
 * @swagger
 * /tasks/{taskId}:
 *   delete:
 *     summary: Cancel task
 *     description: |
 *       Cancels a task (shared contract with the Go agent). Pending tasks flip
 *       to cancelled immediately. Running tasks have their in-flight work
 *       killed and land in cancelled with output preserved. Cancelling an
 *       orchestration parent cascade-cancels its whole pipeline. Tasks already
 *       in a terminal state answer 400 with the current status.
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
 *         description: Task cancelled (or cancellation of a running task is in progress)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 task_id:
 *                   type: string
 *                 was_running:
 *                   type: boolean
 *                   description: True when the task was mid-execution and its work was killed
 *                 message:
 *                   type: string
 *       400:
 *         description: Task is already in a terminal state
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 current_status:
 *                   type: string
 *       404:
 *         description: Task not found
 */
export const cancelTask = async (req, res) => {
  try {
    const { taskId } = req.params;

    const result = await cancelTaskById(taskId);

    if (result.error === 'Task not found') {
      return res.status(404).json({ error: result.error });
    }
    if (result.error && result.currentStatus) {
      return res.status(400).json({
        error: result.error,
        current_status: result.currentStatus,
      });
    }
    if (result.error) {
      return res.status(500).json({ error: result.error });
    }

    return res.json({
      success: true,
      task_id: taskId,
      was_running: result.wasRunning,
      message: result.wasRunning
        ? 'Task cancellation in progress — in-flight work is being killed'
        : 'Task cancelled successfully',
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
 *                 completed_with_errors_tasks:
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
      completed_with_errors_tasks: statMap.completed_with_errors || 0,
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
        status: { [Op.in]: ['completed', 'completed_with_errors', 'failed', 'cancelled'] },
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
        status: { [Op.in]: ['completed', 'completed_with_errors', 'failed', 'cancelled'] },
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
