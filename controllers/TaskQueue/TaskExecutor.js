import {
  executeZoneTask,
  executeServiceTask,
  executeVncStartTask,
  executeDiscoveryTask,
  TASK_OBJECT_OPERATIONS,
} from './ZoneDispatchers.js';
import {
  executeSystemTask,
  executeSystemHostTask,
  executePackageTask,
  executeUserTask,
  executeFileTask,
  executeProcessTraceTask,
} from './SystemDispatchers.js';
import {
  executeNetworkTask,
  executeZFSTask,
  executeZPoolTask,
  executeArtifactTask,
  executeTemplateTask,
} from './StorageNetworkDispatchers.js';
import { runningTasks, runningCategories } from './TaskState.js';
import { taskControls, taskContext } from '../../lib/TaskContext.js';
import { isVncEnabledAtBoot } from '../VncConsoleController/utils/VncCleanupService.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log, createTimer } from '../../lib/Logger.js';
import { taskOutputManager } from '../../lib/TaskOutputManager.js';

/**
 * @fileoverview Task execution engine - routing, lifecycle, and result handling
 */

/**
 * Execute a specific task
 * @param {Object} task - Task object from database
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeTask = async task => {
  const { operation, zone_name } = task;

  try {
    // Task object operations (need progress tracking)
    if (TASK_OBJECT_OPERATIONS[operation]) {
      return await TASK_OBJECT_OPERATIONS[operation](task);
    }

    // Zone operations
    if (
      [
        'start',
        'stop',
        'restart',
        'reset',
        'suspend',
        'resume',
        'delete',
        'discover',
        'zone_attach',
        'zone_detach',
        'zone_move',
      ].includes(operation)
    ) {
      return await executeZoneTask(operation, zone_name, task.metadata);
    }

    // Service operations
    if (operation.startsWith('service_')) {
      return await executeServiceTask(operation, zone_name);
    }

    // Categorized operations
    const systemOps = [
      'set_hostname',
      'update_time_sync_config',
      'force_time_sync',
      'set_timezone',
      'switch_time_sync_system',
    ];
    const networkOps = [
      'create_ip_address',
      'delete_ip_address',
      'enable_ip_address',
      'disable_ip_address',
      'create_vnic',
      'delete_vnic',
      'set_vnic_properties',
      'create_aggregate',
      'delete_aggregate',
      'modify_aggregate_links',
      'create_etherstub',
      'delete_etherstub',
      'create_vlan',
      'delete_vlan',
      'create_bridge',
      'delete_bridge',
      'modify_bridge_links',
      'create_nat_rule',
      'delete_nat_rule',
      'configure_forwarding',
      'dhcp_update_config',
      'dhcp_add_host',
      'dhcp_remove_host',
      'dhcp_service_control',
    ];
    const packageOps = [
      'pkg_install',
      'pkg_uninstall',
      'pkg_update',
      'pkg_refresh',
      'beadm_create',
      'beadm_delete',
      'beadm_activate',
      'beadm_mount',
      'beadm_unmount',
      'repository_add',
      'repository_remove',
      'repository_modify',
      'repository_enable',
      'repository_disable',
    ];
    const userOps = [
      'user_create',
      'user_modify',
      'user_delete',
      'user_set_password',
      'user_lock',
      'user_unlock',
      'group_create',
      'group_modify',
      'group_delete',
      'role_create',
      'role_modify',
      'role_delete',
    ];

    if (systemOps.includes(operation)) {
      return await executeSystemTask(operation, task.metadata);
    }
    if (networkOps.includes(operation)) {
      return await executeNetworkTask(operation, task.metadata);
    }
    if (packageOps.includes(operation)) {
      return await executePackageTask(operation, task.metadata);
    }
    if (userOps.includes(operation)) {
      return await executeUserTask(operation, task.metadata);
    }

    // Prefix-based operations
    if (operation.startsWith('zfs_')) {
      return await executeZFSTask(operation, task.metadata);
    }
    if (operation.startsWith('zpool_')) {
      return await executeZPoolTask(operation, task.metadata);
    }
    if (operation.startsWith('file_')) {
      return await executeFileTask(operation, task.metadata);
    }
    if (operation.startsWith('artifact_')) {
      return await executeArtifactTask(operation, task.metadata, task);
    }
    if (operation.startsWith('template_')) {
      return await executeTemplateTask(operation, task.metadata, task);
    }
    if (operation.startsWith('system_host_')) {
      return await executeSystemHostTask(operation, task.metadata);
    }
    if (operation === 'process_trace') {
      return await executeProcessTraceTask(task.metadata, task.onData);
    }
    if (operation === 'vnc_start') {
      return await executeVncStartTask(zone_name);
    }

    // Discovery operations
    const discoveryOps = [
      'network_config_discovery',
      'network_usage_discovery',
      'storage_discovery',
      'storage_frequent_discovery',
      'device_discovery',
      'system_metrics_discovery',
    ];
    if (discoveryOps.includes(operation)) {
      return await executeDiscoveryTask(operation);
    }

    return { success: false, error: `Unknown operation: ${operation}` };
  } catch (error) {
    log.task.error('Task execution failed', {
      operation,
      zone_name,
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: error.message };
  }
};

/**
 * Update parent task progress based on current child task status.
 * Parents are pure anchors (born running, never dispatched — the Go queue's
 * model): the rollup drives their state and flips them to the terminal
 * status once every child is done — failed (all children failed/cancelled),
 * completed_with_errors (some did), or completed.
 * @param {string} parentTaskId - Parent task ID to update
 */
export const updateParentTaskProgress = async parentTaskId => {
  const parentTask = await Tasks.findByPk(parentTaskId);
  if (!parentTask || parentTask.status !== 'running') {
    return;
  }

  const subTasks = await Tasks.findAll({
    where: { parent_task_id: parentTaskId },
    attributes: ['status'],
  });

  const total = subTasks.length;
  const completed = subTasks.filter(t => t.status === 'completed').length;
  // completed_with_errors is TERMINAL — a nested anchor (sync/provision
  // bracket) lands there when its own children mixed; leaving it uncounted
  // wedges the parent at N-1/N running forever.
  const failed = subTasks.filter(t =>
    ['failed', 'cancelled', 'completed_with_errors'].includes(t.status)
  ).length;
  const done = completed + failed;

  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  let parentStatus = 'running';
  if (total > 0 && done === total) {
    if (failed === total) {
      parentStatus = 'failed';
    } else if (failed > 0) {
      parentStatus = 'completed_with_errors';
    } else {
      parentStatus = 'completed';
    }
  }

  const parentUpdate = {
    progress_percent: percent,
    progress_info: {
      completed_tasks: completed,
      failed_tasks: failed,
      total_tasks: total,
      status: parentStatus,
    },
  };

  if (parentStatus !== 'running') {
    parentUpdate.status = parentStatus;
    parentUpdate.completed_at = new Date();
  }

  await parentTask.update(parentUpdate);

  // Anchors nest (a provisioning orchestration holds sync/provision anchors):
  // a parent reaching its terminal state is a child completing from ITS
  // parent's point of view — recompute up the chain.
  if (parentStatus !== 'running' && parentTask.parent_task_id) {
    await updateParentTaskProgress(parentTask.parent_task_id);
  }
};

/**
 * Execute a task and handle its result
 * @param {Object} task - The task to execute
 * @param {string} operationCategory - The operation category
 */
export const executeAndHandleTask = async (task, operationCategory) => {
  // Create output session for live streaming
  taskOutputManager.create(task.id);
  task.onData = chunk => {
    taskOutputManager.write(task.id, chunk);
  };

  // Execute inside the task's async context so CommandManager registers every
  // spawned child against this task (the running-cancel kill target), with
  // performance timing.
  const taskTimer = createTimer(`Task execution: ${task.operation}`);
  const result = await taskContext.run({ taskId: task.id }, () => executeTask(task));
  const executionTime = taskTimer.end();

  // A cancel marked the control while the executor ran (and killed its
  // children) — the row lands in cancelled with its output preserved (D-F).
  const cancelled = taskControls.get(task.id)?.cancelled === true;
  taskControls.delete(task.id);

  let status = 'failed';
  if (cancelled) {
    status = 'cancelled';
  } else if (result.success) {
    status = 'completed';
  }

  const updateData = {
    status,
    completed_at: new Date(),
    error_message: cancelled ? null : result.error || null,
  };

  // Set progress to 100% for successful tasks (unless already set by task execution)
  if (status === 'completed' && task.progress_percent < 100) {
    updateData.progress_percent = 100;
    updateData.progress_info = {
      status: 'completed',
      completed_at: new Date().toISOString(),
    };
  }

  await task.update(updateData);

  // Finalize output session (flush to DB, write log file, cleanup)
  await taskOutputManager.finalize(task.id);

  runningTasks.delete(task.id);

  // Update parent task progress if this was a sub-task
  if (task.parent_task_id) {
    try {
      await updateParentTaskProgress(task.parent_task_id);
    } catch (parentError) {
      log.task.error('Failed to update parent task progress', { error: parentError.message });
    }
  }

  // Release operation category lock if it had one
  if (operationCategory) {
    runningCategories.delete(operationCategory);
    log.task.debug('Released category lock', {
      task_id: task.id,
      category: operationCategory,
    });
  }

  if (status === 'cancelled') {
    log.task.info('Task cancelled', {
      task_id: task.id,
      operation: task.operation,
      zone_name: task.zone_name,
      duration_ms: executionTime,
    });
    return;
  }

  if (result.success) {
    // Auto-start VNC for zones that have VNC enabled at boot after a
    // successful zone start (reset and resume boot the zone too)
    if (['start', 'reset', 'resume'].includes(task.operation) && task.zone_name !== 'system') {
      try {
        const vncEnabled = await isVncEnabledAtBoot(task.zone_name);
        if (vncEnabled) {
          log.task.info('Zone has VNC enabled at boot - creating auto-VNC start task', {
            zone_name: task.zone_name,
            trigger_task_id: task.id,
          });

          // Create low-priority VNC start task (non-blocking)
          await Tasks.create({
            zone_name: task.zone_name,
            operation: 'vnc_start',
            priority: TaskPriority.LOW,
            created_by: 'auto_vnc_startup',
            status: 'pending',
          });
        } else {
          log.task.debug('Zone does not have VNC enabled at boot', {
            zone_name: task.zone_name,
          });
        }
      } catch (vncCheckError) {
        log.task.warn('Failed to check VNC boot setting for auto-start', {
          zone_name: task.zone_name,
          error: vncCheckError.message,
        });
      }
    }

    // Only log slow tasks to reduce noise
    if (executionTime > 5000) {
      log.performance.warn('Slow task execution', {
        task_id: task.id,
        operation: task.operation,
        zone_name: task.zone_name,
        duration_ms: executionTime,
        message: result.message,
      });
    }
  } else {
    log.task.error('Task execution failed', {
      task_id: task.id,
      operation: task.operation,
      zone_name: task.zone_name,
      duration_ms: executionTime,
      error: result.error,
    });
  }
};
