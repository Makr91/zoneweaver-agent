/**
 * @fileoverview Upload Helper Functions for Artifact Management
 * @description Utilities for handling artifact upload validation and configuration
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import path from 'path';
import multer from 'multer';
import Tasks from '../../../models/TaskModel.js';
import { log } from '../../../lib/Logger.js';
import { executeCommand } from '../../../lib/FileSystemManager.js';

/**
 * Validate the upload task and ensure it's in the correct state
 * @param {string} taskId - The task ID to validate
 * @param {string} requestId - Request ID for logging
 * @returns {Promise<Object>} The validated task object
 * @throws {Error} If task is invalid or not in correct state
 */
export const getAndValidateUploadTask = async (taskId, requestId) => {
  if (!taskId) {
    log.artifact.error('UPLOAD DEBUG: Task ID is required', { requestId });
    throw new Error('taskId parameter is required');
  }

  const task = await Tasks.findByPk(taskId);
  if (!task) {
    log.artifact.error('UPLOAD DEBUG: Task not found', { requestId, taskId });
    throw new Error('Upload task not found');
  }

  if (task.operation !== 'artifact_upload') {
    log.artifact.error('UPLOAD DEBUG: Invalid task type for upload', { requestId, taskId });
    throw new Error('Invalid task type for upload');
  }

  if (task.status !== 'prepared') {
    log.artifact.error('UPLOAD DEBUG: Task not in prepared state', {
      requestId,
      taskId,
      current_status: task.status,
    });
    throw new Error(`Task is not in prepared state. Current status: ${task.status}`);
  }

  return task;
};

/**
 * Configure Multer for file upload handling
 * @param {Object} storageLocation - Storage location object
 * @param {number} maxUploadSizeBytes - Maximum upload size in bytes
 * @param {string} requestId - Request ID for logging
 * @returns {Function} Configured multer middleware
 */
export const configureMulter = (storageLocation, maxUploadSizeBytes, requestId) => {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      void req;
      void file;
      cb(null, storageLocation.path);
    },
    filename: async (req, file, cb) => {
      void req;
      try {
        const finalPath = path.join(storageLocation.path, file.originalname);
        // Pre-create file with pfexec and set writable permissions
        const createResult = await executeCommand(`pfexec touch "${finalPath}"`);
        if (!createResult.success) {
          throw new Error(`Failed to pre-create file: ${createResult.error}`);
        }
        const chmodResult = await executeCommand(`pfexec chmod 666 "${finalPath}"`);
        if (!chmodResult.success) {
          throw new Error(`Failed to set file permissions: ${chmodResult.error}`);
        }
        return cb(null, file.originalname);
      } catch (error) {
        log.artifact.error('UPLOAD DEBUG: Exception in multer filename callback', {
          requestId,
          error: error.message,
        });
        return cb(error);
      }
    },
  });

  return multer({
    storage,
    limits: {
      fileSize: maxUploadSizeBytes,
    },
  }).single('file');
};
