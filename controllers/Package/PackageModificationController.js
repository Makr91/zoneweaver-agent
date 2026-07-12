/**
 * @fileoverview Package Modification Controller for Zoneweaver Agent
 * @description Handles package install and uninstall task creation via pkg commands
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/packages/install:
 *   post:
 *     summary: Install package
 *     description: Install one or more packages
 *     tags: [Package Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - packages
 *             properties:
 *               packages:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of package names to install
 *               accept_licenses:
 *                 type: boolean
 *                 default: false
 *                 description: Accept package licenses automatically
 *               dry_run:
 *                 type: boolean
 *                 default: false
 *                 description: Perform dry run without installing
 *               be_name:
 *                 type: string
 *                 description: Boot environment name to create for installation
 *     responses:
 *       202:
 *         description: Package installation task created successfully
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
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create installation task
 */
export const installPackages = async (req, res) => {
  const { packages, accept_licenses = false, dry_run = false, be_name } = req.body;

  try {
    if (!packages || !Array.isArray(packages) || packages.length === 0) {
      return res.status(400).json({
        error: 'packages array is required and must not be empty',
      });
    }

    // Create task for package installation
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'pkg_install',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            packages,
            accept_licenses,
            dry_run,
            be_name,
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
      message: `Package installation task created for ${packages.length} package(s)`,
      task_id: task.id,
      packages,
      dry_run,
    });
  } catch (error) {
    log.api.error('Error installing packages', {
      error: error.message,
      stack: error.stack,
      packages,
      dry_run,
    });
    return res.status(500).json({
      error: 'Failed to create package installation task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/packages/uninstall:
 *   post:
 *     summary: Uninstall package
 *     description: Uninstall one or more packages
 *     tags: [Package Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - packages
 *             properties:
 *               packages:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of package names to uninstall
 *               dry_run:
 *                 type: boolean
 *                 default: false
 *                 description: Perform dry run without uninstalling
 *               be_name:
 *                 type: string
 *                 description: Boot environment name to create for uninstallation
 *     responses:
 *       202:
 *         description: Package uninstallation task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create uninstallation task
 */
export const uninstallPackages = async (req, res) => {
  const { packages, dry_run = false, be_name } = req.body;

  try {
    if (!packages || !Array.isArray(packages) || packages.length === 0) {
      return res.status(400).json({
        error: 'packages array is required and must not be empty',
      });
    }

    // Create task for package uninstallation
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'pkg_uninstall',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            packages,
            dry_run,
            be_name,
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
      message: `Package uninstallation task created for ${packages.length} package(s)`,
      task_id: task.id,
      packages,
      dry_run,
    });
  } catch (error) {
    log.api.error('Error uninstalling packages', {
      error: error.message,
      stack: error.stack,
      packages,
      dry_run,
    });
    return res.status(500).json({
      error: 'Failed to create package uninstallation task',
      details: error.message,
    });
  }
};
