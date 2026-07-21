import { parseAsync } from './AsyncJson.js';
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
export const parseTaskMetadata = task => parseAsync(task.metadata);

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

/**
 * Byte-progress reporter for registry transfers — the converged task wire
 * (both agents, 2026-07-17): the task percent maps bytes into the transfer's
 * [windowStart, windowEnd] window, progress_info carries
 * {status, received_bytes, total_bytes|null}, throttled to ≥1s or ≥1%
 * between updates. An unknown total keeps the percent parked at the window
 * start — the byte counter still moves every second.
 * @param {Object} task - Task record
 * @param {Object} options - Transfer window
 * @param {string} options.status - 'downloading' | 'uploading'
 * @param {number} options.windowStart - Window start percent
 * @param {number} options.windowEnd - Window end percent
 * @param {number|null} [options.totalBytes] - Expected size (null = unknown)
 * @returns {(receivedBytes: number) => void} Reporter (detached writes)
 */
export const createTransferProgress = (
  task,
  { status, windowStart, windowEnd, totalBytes = null }
) => {
  let lastUpdate = 0;
  let lastPercent = -1;
  return receivedBytes => {
    const percent = totalBytes
      ? windowStart + Math.min(receivedBytes / totalBytes, 1) * (windowEnd - windowStart)
      : windowStart;
    const rounded = Math.round(percent);
    const now = Date.now();
    if (now - lastUpdate < 1000 && rounded - lastPercent < 1) {
      return;
    }
    lastUpdate = now;
    lastPercent = rounded;
    setImmediate(() => {
      updateTaskProgress(task, rounded, {
        status,
        received_bytes: receivedBytes,
        total_bytes: totalBytes,
      });
    });
  };
};
