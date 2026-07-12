import config from '../../config/ConfigLoader.js';

/**
 * @fileoverview Shared mutable state for the task queue system. Per-task run
 * controls and the executor async context live in lib/TaskContext.js (they
 * are consumed from lib code too).
 */

/**
 * Task execution queue - in-memory tracking of running tasks
 */
export const runningTasks = new Map();

/**
 * Track running operation categories to prevent conflicts
 */
export const runningCategories = new Set();

/**
 * Maximum number of concurrent tasks
 */
export const MAX_CONCURRENT_TASKS = config.getZones().max_concurrent_tasks || 5;

/**
 * Processor interval state - mutable references for start/stop lifecycle
 */
export const processorState = {
  taskProcessor: null,
  discoveryProcessor: null,
  networkConfigProcessor: null,
  networkUsageProcessor: null,
  storageProcessor: null,
  storageFrequentProcessor: null,
  deviceProcessor: null,
  systemMetricsProcessor: null,
};
