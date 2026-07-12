import Tasks from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import { runningTasks } from './TaskState.js';
import { taskControls } from '../../lib/TaskContext.js';
import { updateParentTaskProgress } from './TaskExecutor.js';

/**
 * @fileoverview Task cancellation core — the Go queue's D-F cancel flow.
 * Pending tasks flip to cancelled immediately; running tasks get their
 * spawned children killed and land in cancelled with output preserved;
 * running rows NOT in this process (parent anchors, crash leftovers) close
 * out directly and cascade-cancel their children.
 */

/**
 * Grace before an unkilled child escalates from SIGTERM to SIGKILL.
 */
const KILL_ESCALATION_MS = 10000;

/**
 * Kill every child process registered for a running task: SIGTERM first,
 * SIGKILL after the grace window for anything still alive.
 * @param {{children: Set<import('child_process').ChildProcess>}} control - Task run control
 * @param {string} taskId - Task id (logging)
 */
const killTaskChildren = (control, taskId) => {
  for (const child of control.children) {
    try {
      child.kill('SIGTERM');
    } catch (error) {
      log.task.warn('Failed to signal task child process', {
        task_id: taskId,
        pid: child.pid,
        error: error.message,
      });
    }
  }
  const survivors = [...control.children];
  if (survivors.length > 0) {
    setTimeout(() => {
      for (const child of survivors) {
        if (child.exitCode === null && !child.killed) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }
    }, KILL_ESCALATION_MS).unref();
  }
};

/**
 * Cancel one task (the DELETE /tasks/{id} core). Mirrors the Go queue's
 * Cancel: pending flips with a lost-race retry; running-in-process marks the
 * control cancelled and kills the registered children (the executor then
 * lands the row in cancelled with its output); running-in-database-only is a
 * parent anchor or stale leftover — closed out directly, with every
 * unfinished child cascade-cancelled in turn (sequential on purpose: each
 * cancel may cascade further and recompute rollups).
 * @param {string} taskId - Task id
 * @param {number} [attempt] - Lost-race retry depth (internal)
 * @returns {Promise<{cancelled?: boolean, wasRunning?: boolean, error?: string, currentStatus?: string}>}
 */
export const cancelTaskById = async (taskId, attempt = 0) => {
  if (attempt >= 5) {
    return { error: 'Task state kept changing during cancellation — retry' };
  }

  const task = await Tasks.findByPk(taskId);
  if (!task) {
    return { error: 'Task not found' };
  }

  if (task.status === 'pending' || task.status === 'prepared') {
    const [flipped] = await Tasks.update(
      { status: 'cancelled', completed_at: new Date() },
      { where: { id: taskId, status: task.status } }
    );
    if (flipped === 0) {
      // Lost the race with the queue loop — retry as the state it moved to.
      return cancelTaskById(taskId, attempt + 1);
    }
    if (task.parent_task_id) {
      await updateParentTaskProgress(task.parent_task_id);
    }
    return { cancelled: true, wasRunning: false };
  }

  if (task.status === 'running') {
    const control = taskControls.get(taskId);
    if (control) {
      control.cancelled = true;
      killTaskChildren(control, taskId);
      log.task.info('Running task cancellation requested', {
        task_id: taskId,
        operation: task.operation,
        zone_name: task.zone_name,
        children_signalled: control.children.size,
      });
      return { cancelled: true, wasRunning: true };
    }

    // Running in the database but not in this process: a parent anchor
    // (never dispatched — child completions drive it) or a stale crash
    // leftover. The anchor leaves running FIRST so child completions no
    // longer recompute it, then the cascade takes its chain down —
    // cancelling an orchestration cancels the whole pipeline.
    await task.update({ status: 'cancelled', completed_at: new Date() });
    runningTasks.delete(taskId);

    const children = await Tasks.findAll({
      where: { parent_task_id: taskId, status: ['pending', 'running'] },
      attributes: ['id'],
    });
    await children.reduce(
      (chain, child) =>
        chain.then(() =>
          cancelTaskById(child.id).then(result => {
            if (result.error) {
              log.task.warn('Cascade-cancel child task', {
                task_id: child.id,
                parent_task_id: taskId,
                error: result.error,
              });
            }
          })
        ),
      Promise.resolve()
    );

    if (task.parent_task_id) {
      await updateParentTaskProgress(task.parent_task_id);
    }
    log.task.info('Parent anchor cancelled with cascade', {
      task_id: taskId,
      operation: task.operation,
      zone_name: task.zone_name,
      children_cancelled: children.length,
    });
    return { cancelled: true, wasRunning: false };
  }

  return { error: `Task is ${task.status}`, currentStatus: task.status };
};
