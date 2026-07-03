/**
 * @fileoverview Response Helper Utilities for System Host Management
 * @description Common response patterns and task creation helpers
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import Tasks, { TaskPriority } from '../../../models/TaskModel.js';
import { log } from '../../../lib/Logger.js';
import yj from 'yieldable-json';

/**
 * Create a system management task
 * @param {string} operation - Task operation name
 * @param {Object} metadata - Task metadata
 * @param {string} createdBy - User/entity creating the task
 * @param {string} priority - Task priority (default: HIGH for system operations)
 * @returns {Promise<Object>} Created task object
 */
export const createSystemTask = async (
  operation,
  metadata,
  createdBy,
  priority = TaskPriority.HIGH
) => {
  try {
    const task = await Tasks.create({
      zone_name: 'system',
      operation,
      priority,
      created_by: createdBy,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(metadata, (err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        });
      }),
    });

    log.monitoring.info('System management task created', {
      task_id: task.id,
      operation,
      created_by: createdBy,
      priority,
    });

    return task;
  } catch (error) {
    log.api.error('Failed to create system management task', {
      operation,
      error: error.message,
      created_by: createdBy,
    });
    throw error;
  }
};

/**
 * Standard success response for task-based operations
 * @param {Object} res - Express response object
 * @param {string} message - Success message
 * @param {Object} task - Task object
 * @param {Object} additionalData - Additional response data
 * @returns {Object} Response object
 */
export const taskCreatedResponse = (res, message, task, additionalData = {}) =>
  res.status(202).json({
    success: true,
    message,
    task_id: task.id,
    status: task.status,
    created_at: task.createdAt,
    ...additionalData,
  });

/**
 * Standard success response for direct operations
 * @param {Object} res - Express response object
 * @param {string} message - Success message
 * @param {Object} data - Response data
 * @returns {Object} Response object
 */
export const directSuccessResponse = (res, message, data = {}) =>
  res.json({
    success: true,
    message,
    timestamp: new Date().toISOString(),
    ...data,
  });

/**
 * Standard error response
 * @param {Object} res - Express response object
 * @param {number} statusCode - HTTP status code
 * @param {string} error - Error message
 * @param {string} details - Detailed error information
 * @returns {Object} Response object
 */
export const errorResponse = (res, statusCode, error, details = null) => {
  const response = {
    success: false,
    error,
    timestamp: new Date().toISOString(),
  };

  if (details) {
    response.details = details;
  }

  return res.status(statusCode).json(response);
};
