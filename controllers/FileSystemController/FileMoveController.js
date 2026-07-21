import { moveItem, getItemInfo } from '../../lib/FileSystemManager.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';
import { stringifyAsync } from '../../lib/AsyncJson.js';
import path from 'path';

/**
 * @fileoverview File move, copy, and rename controllers
 */

/**
 * @swagger
 * /filesystem/move:
 *   put:
 *     summary: Move or rename item
 *     tags: [File System]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - source
 *               - destination
 *             properties:
 *               source:
 *                 type: string
 *                 description: Source path
 *                 example: "/home/user/file.txt"
 *               destination:
 *                 type: string
 *                 description: Destination path
 *                 example: "/home/user/renamed.txt"
 *     responses:
 *       202:
 *         description: Move task created successfully
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Access forbidden
 *       500:
 *         description: Failed to create move task
 */
export const moveFileItem = async (req, res) => {
  const { source, destination } = req.body;

  try {
    const fileBrowserConfig = config.getFileBrowser();

    if (!fileBrowserConfig?.enabled) {
      return res.status(503).json({
        error: 'File browser is disabled',
      });
    }

    if (!source || !destination) {
      return res.status(400).json({
        error: 'source and destination are required',
      });
    }

    // Create task for move operation (async for large files/directories)
    const task = await Tasks.create({
      zone_name: 'filesystem',
      operation: 'file_move',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        source,
        destination,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Move task created for '${path.basename(source)}'`,
      task_id: task.id,
      source,
      destination,
    });
  } catch (error) {
    log.api.error('Error creating move task', {
      error: error.message,
      stack: error.stack,
      source,
      destination,
    });

    if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
      return res.status(403).json({ error: error.message });
    }

    return res.status(500).json({
      error: 'Failed to create move task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /filesystem/copy:
 *   post:
 *     summary: Copy item
 *     tags: [File System]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - source
 *               - destination
 *             properties:
 *               source:
 *                 type: string
 *                 description: Source path
 *                 example: "/home/user/file.txt"
 *               destination:
 *                 type: string
 *                 description: Destination path
 *                 example: "/home/user/file_copy.txt"
 *     responses:
 *       202:
 *         description: Copy task created successfully
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Access forbidden
 *       500:
 *         description: Failed to create copy task
 */
export const copyFileItem = async (req, res) => {
  const { source, destination } = req.body;

  try {
    const fileBrowserConfig = config.getFileBrowser();

    if (!fileBrowserConfig?.enabled) {
      return res.status(503).json({
        error: 'File browser is disabled',
      });
    }

    if (!source || !destination) {
      return res.status(400).json({
        error: 'source and destination are required',
      });
    }

    // Create task for copy operation (async for large files/directories)
    const task = await Tasks.create({
      zone_name: 'filesystem',
      operation: 'file_copy',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        source,
        destination,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Copy task created for '${path.basename(source)}'`,
      task_id: task.id,
      source,
      destination,
    });
  } catch (error) {
    log.api.error('Error creating copy task', {
      error: error.message,
      stack: error.stack,
      source,
      destination,
    });

    if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
      return res.status(403).json({ error: error.message });
    }

    return res.status(500).json({
      error: 'Failed to create copy task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /filesystem/rename:
 *   patch:
 *     summary: Rename item
 *     tags: [File System]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - path
 *               - new_name
 *             properties:
 *               path:
 *                 type: string
 *                 description: Current item path
 *                 example: "/home/user/old_name.txt"
 *               new_name:
 *                 type: string
 *                 description: New name for the item
 *                 example: "new_name.txt"
 *     responses:
 *       200:
 *         description: Item renamed successfully
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Access forbidden
 *       409:
 *         description: Target name already exists
 *       500:
 *         description: Failed to rename item
 */
export const renameItem = async (req, res) => {
  const { path: itemPath, new_name } = req.body;

  try {
    const fileBrowserConfig = config.getFileBrowser();

    if (!fileBrowserConfig?.enabled) {
      return res.status(503).json({
        error: 'File browser is disabled',
      });
    }

    if (!itemPath || !new_name) {
      return res.status(400).json({
        error: 'path and new_name are required',
      });
    }

    // Sanitize new name
    const sanitizedName = new_name.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (sanitizedName !== new_name) {
      log.filesystem.warn('Sanitized filename', {
        original: new_name,
        sanitized: sanitizedName,
      });
    }

    const parentDir = path.dirname(itemPath);
    const newPath = path.join(parentDir, sanitizedName);

    await moveItem(itemPath, newPath);

    const itemInfo = await getItemInfo(newPath);

    return res.json({
      success: true,
      message: `Item renamed to '${sanitizedName}' successfully`,
      item: itemInfo,
      old_path: itemPath,
      new_path: newPath,
    });
  } catch (error) {
    log.filesystem.error('Error renaming item', {
      error: error.message,
      stack: error.stack,
      path: itemPath,
      new_name,
    });

    if (error.message.includes('already exists')) {
      return res.status(409).json({ error: error.message });
    }

    if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
      return res.status(403).json({ error: error.message });
    }

    return res.status(500).json({
      error: 'Failed to rename item',
      details: error.message,
    });
  }
};
