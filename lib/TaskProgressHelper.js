import yj from 'yieldable-json';
import { log } from './Logger.js';

/**
 * @fileoverview Shared task utilities — progress tracking and metadata parsing
 */

/**
 * Parse a task row's JSON metadata (non-blocking) — the ONE wrapper every
 * executor uses.
 * @param {Object} task - Task record
 * @returns {Promise<Object>} Parsed metadata
 */
export const parseTaskMetadata = task =>
  new Promise((resolve, reject) => {
    yj.parseAsync(task.metadata, (err, result) => (err ? reject(err) : resolve(result)));
  });

/**
 * Update task progress
 * @param {Object} task - Task record
 * @param {number} percent - Progress percentage
 * @param {Object} info - Progress info object
 */
export const updateTaskProgress = async (task, percent, info) => {
  if (!task) {
    return;
  }
  try {
    await task.update({
      progress_percent: percent,
      progress_info: info,
    });
  } catch (error) {
    log.task.debug('Progress update failed', { error: error.message });
  }
};
