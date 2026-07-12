/**
 * @fileoverview System Update Task Controller for Zoneweaver Agent
 * @description Handles update install and metadata refresh task creation via pkg commands
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/updates/install:
 *   post:
 *     summary: Install system updates
 *     description: Install available system updates using pkg update
 *     tags: [System Updates]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               packages:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Specific packages to update (optional, updates all if not specified)
 *               accept_licenses:
 *                 type: boolean
 *                 default: false
 *                 description: Accept package licenses automatically
 *               be_name:
 *                 type: string
 *                 description: Boot environment name to create for updates
 *               backup_be:
 *                 type: boolean
 *                 default: true
 *                 description: Create backup boot environment
 *               reject_packages:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Package patterns to reject during update
 *     responses:
 *       202:
 *         description: System update task created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 task_id:
 *                   type: string
 *                 packages:
 *                   type: array
 *                   items:
 *                     type: string
 *       500:
 *         description: Failed to create update task
 */
export const installUpdates = async (req, res) => {
  try {
    const {
      packages = [],
      accept_licenses = false,
      be_name,
      backup_be = true,
      reject_packages = [],
    } = req.body || {};

    // Create task for system update
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'pkg_update',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            packages,
            accept_licenses,
            be_name,
            backup_be,
            reject_packages,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message:
        packages.length > 0
          ? `System update task created for ${packages.length} specific package(s)`
          : 'System update task created for all available updates',
      task_id: task.id,
      packages,
      backup_be,
      be_name: be_name || 'auto-generated',
    });
  } catch (error) {
    log.api.error('Error creating system update task', {
      error: error.message,
      stack: error.stack,
      packages: req.body?.packages,
      backup_be: req.body?.backup_be,
    });
    return res.status(500).json({
      error: 'Failed to create system update task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/updates/refresh:
 *   post:
 *     summary: Refresh package metadata
 *     description: Refresh package repository metadata using pkg refresh
 *     tags: [System Updates]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               full:
 *                 type: boolean
 *                 default: false
 *                 description: Force full retrieval of all metadata
 *               publishers:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Specific publishers to refresh (optional)
 *     responses:
 *       202:
 *         description: Metadata refresh task created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 task_id:
 *                   type: string
 *       500:
 *         description: Failed to create refresh task
 */
export const refreshMetadata = async (req, res) => {
  try {
    const { full = false, publishers = [] } = req.body || {};

    // Create task for metadata refresh
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'pkg_refresh',
      priority: TaskPriority.LOW,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            full,
            publishers,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message:
        publishers.length > 0
          ? `Metadata refresh task created for ${publishers.length} publisher(s)`
          : 'Metadata refresh task created for all publishers',
      task_id: task.id,
      full,
      publishers,
    });
  } catch (error) {
    log.api.error('Error creating metadata refresh task', {
      error: error.message,
      stack: error.stack,
      full: req.body?.full,
      publishers: req.body?.publishers,
    });
    return res.status(500).json({
      error: 'Failed to create metadata refresh task',
      details: error.message,
    });
  }
};
