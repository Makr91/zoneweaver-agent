import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { Op } from 'sequelize';
import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';
import { OPERATION_CATEGORIES } from './OperationCategories.js';
import {
  runningTasks,
  runningCategories,
  processorState,
  MAX_CONCURRENT_TASKS,
} from './TaskState.js';
import { executeAndHandleTask, updateParentTaskProgress } from './TaskExecutor.js';

/**
 * @fileoverview Task processor - queue processing and periodic task scheduling
 */

/**
 * Process next task from queue
 */
const processNextTask = async () => {
  try {
    // Don't start new tasks if we're at max capacity
    if (runningTasks.size >= MAX_CONCURRENT_TASKS) {
      return;
    }

    // Resolve dependency gating from the small PENDING set instead of scanning
    // the month of completed/failed history the tasks table retains — this
    // runs every 2 seconds, so it must stay bounded by queue depth, not by
    // table size.
    const pendingWithDeps = await Tasks.findAll({
      where: { status: 'pending', depends_on: { [Op.ne]: null } },
      attributes: ['id', 'depends_on', 'parent_task_id'],
      raw: true,
    });

    let completedDepIds = [];
    if (pendingWithDeps.length > 0) {
      const depIds = [...new Set(pendingWithDeps.map(t => t.depends_on))];
      const deps = await Tasks.findAll({
        where: { id: { [Op.in]: depIds } },
        attributes: ['id', 'status'],
        raw: true,
      });
      const depStatus = new Map(deps.map(d => [d.id, d.status]));

      // A dependency that failed, was cancelled, or no longer exists (cleaned
      // up) can never complete — cancel its dependents.
      const tasksToCancel = pendingWithDeps.filter(t => {
        const status = depStatus.get(t.depends_on);
        return status === 'failed' || status === 'cancelled' || status === undefined;
      });

      if (tasksToCancel.length > 0) {
        // Bulk cancel dependent tasks
        await Tasks.update(
          { status: 'cancelled', error_message: 'Dependency failed', completed_at: new Date() },
          { where: { id: { [Op.in]: tasksToCancel.map(t => t.id) } } }
        );

        // Update parent tasks for all cancelled tasks (parallel execution)
        const parentIds = [...new Set(tasksToCancel.map(t => t.parent_task_id).filter(Boolean))];
        await Promise.all(
          parentIds.map(parentId =>
            updateParentTaskProgress(parentId).catch(err => {
              log.task.error('Failed to update parent task progress after bulk cancellation', {
                parent_task_id: parentId,
                error: err.message,
              });
            })
          )
        );
      }

      completedDepIds = depIds.filter(id => depStatus.get(id) === 'completed');
    }

    // Find highest priority pending task that's not blocked by dependencies
    const task = await Tasks.findOne({
      where: {
        status: 'pending',
        [Op.or]: [{ depends_on: null }, { depends_on: { [Op.in]: completedDepIds } }],
      },
      order: [
        ['priority', 'DESC'],
        ['created_at', 'ASC'],
      ],
    });

    if (!task) {
      return; // No tasks available
    }

    // Check for operation category conflicts
    const operationCategory = OPERATION_CATEGORIES[task.operation];
    if (operationCategory && runningCategories.has(operationCategory)) {
      log.task.warn('Task waiting for category lock', {
        task_id: task.id,
        operation: task.operation,
        category: operationCategory,
        zone_name: task.zone_name,
      });
      return; // Cannot start this task due to category conflict
    }

    // Mark task as running
    await task.update({
      status: 'running',
      started_at: new Date(),
    });

    runningTasks.set(task.id, task);

    // Add operation category to running set if it has one
    if (operationCategory) {
      runningCategories.add(operationCategory);
      log.task.debug('Acquired category lock', {
        task_id: task.id,
        category: operationCategory,
      });
    }

    log.task.info('Task started', {
      task_id: task.id,
      operation: task.operation,
      zone_name: task.zone_name,
      category: operationCategory || 'none',
    });

    await executeAndHandleTask(task, operationCategory);
  } catch (error) {
    log.task.error('Task processing error', {
      error: error.message,
      stack: error.stack,
      running_task_count: runningTasks.size,
      running_categories: Array.from(runningCategories),
    });

    // Make sure to clean up category lock on error
    const lastRunningTask = await Tasks.findOne({
      where: { status: 'running' },
      order: [['started_at', 'DESC']],
    });

    if (lastRunningTask) {
      const failedCategory = OPERATION_CATEGORIES[lastRunningTask.operation];
      if (failedCategory && runningCategories.has(failedCategory)) {
        runningCategories.delete(failedCategory);
        log.task.warn('Emergency category lock cleanup', {
          task_id: lastRunningTask.id,
          category: failedCategory,
          reason: 'Task processing error',
        });
      }
    }
  }
};

/**
 * Start the task processor
 */
export const startTaskProcessor = () => {
  if (processorState.taskProcessor) {
    return; // Already running
  }

  log.task.info('Starting task processor');

  // Process tasks every 2 seconds ## THIS SHOULD BE CONFIGURABLE!!
  processorState.taskProcessor = setInterval(async () => {
    await processNextTask();
  }, 2000);

  // Get zones configuration for discovery settings
  const zonesConfig = config.getZones();

  // Start periodic discovery if enabled
  if (zonesConfig.auto_discovery && zonesConfig.discovery_interval) {
    log.task.info('Starting periodic zone discovery', {
      interval_seconds: zonesConfig.discovery_interval,
    });

    // Start periodic discovery interval
    processorState.discoveryProcessor = setInterval(async () => {
      await Tasks.create({
        zone_name: 'system',
        operation: 'discover',
        priority: TaskPriority.BACKGROUND,
        created_by: 'system_periodic',
        status: 'pending',
      });
    }, zonesConfig.discovery_interval * 1000);
  }

  // Initial discovery task
  setTimeout(async () => {
    await Tasks.create({
      zone_name: 'system',
      operation: 'discover',
      priority: TaskPriority.BACKGROUND,
      created_by: 'system_startup',
      status: 'pending',
    });
  }, 5000);

  // Get host monitoring configuration for discovery intervals
  const hostMonitoringConfig = config.getHostMonitoring();

  if (hostMonitoringConfig.enabled && hostMonitoringConfig.intervals) {
    const { intervals } = hostMonitoringConfig;

    log.task.info('Starting periodic host monitoring discovery tasks', {
      network_config_interval: intervals.network_config,
      network_usage_interval: intervals.network_usage,
      storage_interval: intervals.storage,
      storage_frequent_interval: intervals.storage_frequent,
      device_discovery_interval: intervals.device_discovery,
      system_metrics_interval: intervals.system_metrics,
    });

    // Network config discovery
    processorState.networkConfigProcessor = setInterval(async () => {
      await Tasks.create({
        zone_name: 'system',
        operation: 'network_config_discovery',
        priority: TaskPriority.BACKGROUND,
        created_by: 'system_periodic',
        status: 'pending',
      });
    }, intervals.network_config * 1000);

    // Network usage discovery
    processorState.networkUsageProcessor = setInterval(async () => {
      await Tasks.create({
        zone_name: 'system',
        operation: 'network_usage_discovery',
        priority: TaskPriority.BACKGROUND,
        created_by: 'system_periodic',
        status: 'pending',
      });
    }, intervals.network_usage * 1000);

    // Storage discovery
    processorState.storageProcessor = setInterval(async () => {
      await Tasks.create({
        zone_name: 'system',
        operation: 'storage_discovery',
        priority: TaskPriority.BACKGROUND,
        created_by: 'system_periodic',
        status: 'pending',
      });
    }, intervals.storage * 1000);

    // Storage frequent metrics discovery
    processorState.storageFrequentProcessor = setInterval(async () => {
      await Tasks.create({
        zone_name: 'system',
        operation: 'storage_frequent_discovery',
        priority: TaskPriority.BACKGROUND,
        created_by: 'system_periodic',
        status: 'pending',
      });
    }, intervals.storage_frequent * 1000);

    // Device discovery
    processorState.deviceProcessor = setInterval(async () => {
      await Tasks.create({
        zone_name: 'system',
        operation: 'device_discovery',
        priority: TaskPriority.BACKGROUND,
        created_by: 'system_periodic',
        status: 'pending',
      });
    }, intervals.device_discovery * 1000);

    // System metrics discovery
    processorState.systemMetricsProcessor = setInterval(async () => {
      await Tasks.create({
        zone_name: 'system',
        operation: 'system_metrics_discovery',
        priority: TaskPriority.BACKGROUND,
        created_by: 'system_periodic',
        status: 'pending',
      });
    }, intervals.system_metrics * 1000);
  }
};

/**
 * Stop the task processor
 */
export const stopTaskProcessor = () => {
  if (processorState.taskProcessor) {
    clearInterval(processorState.taskProcessor);
    processorState.taskProcessor = null;
    log.task.info('Task processor stopped');
  }

  if (processorState.discoveryProcessor) {
    clearInterval(processorState.discoveryProcessor);
    processorState.discoveryProcessor = null;
    log.task.info('Periodic zone discovery stopped');
  }

  if (processorState.networkConfigProcessor) {
    clearInterval(processorState.networkConfigProcessor);
    processorState.networkConfigProcessor = null;
  }

  if (processorState.networkUsageProcessor) {
    clearInterval(processorState.networkUsageProcessor);
    processorState.networkUsageProcessor = null;
  }

  if (processorState.storageProcessor) {
    clearInterval(processorState.storageProcessor);
    processorState.storageProcessor = null;
  }

  if (processorState.storageFrequentProcessor) {
    clearInterval(processorState.storageFrequentProcessor);
    processorState.storageFrequentProcessor = null;
  }

  if (processorState.deviceProcessor) {
    clearInterval(processorState.deviceProcessor);
    processorState.deviceProcessor = null;
  }

  if (processorState.systemMetricsProcessor) {
    clearInterval(processorState.systemMetricsProcessor);
    processorState.systemMetricsProcessor = null;
  }
};
