import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';
import { stringifyAsync } from '../../lib/AsyncJson.js';
import path from 'path';

/**
 * @fileoverview Archive creation and extraction controllers
 */

/**
 * @swagger
 * /filesystem/archive/create:
 *   post:
 *     summary: Create archive
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
 *               - sources
 *               - archive_path
 *               - format
 *             properties:
 *               sources:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of source paths to archive
 *                 example: ["/home/user/file1.txt", "/home/user/folder"]
 *               archive_path:
 *                 type: string
 *                 description: Destination archive file path
 *                 example: "/home/user/backup.tar.gz"
 *               format:
 *                 type: string
 *                 enum: [zip, tar, tar.gz, tar.bz2, gz]
 *                 description: Archive format
 *     responses:
 *       202:
 *         description: Archive creation task created successfully
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Access forbidden
 *       500:
 *         description: Failed to create archive task
 */
export const createArchiveTask = async (req, res) => {
  const { sources, archive_path, format } = req.body;

  try {
    const fileBrowserConfig = config.getFileBrowser();

    if (!fileBrowserConfig?.enabled || !fileBrowserConfig.archive?.enabled) {
      return res.status(503).json({
        error: 'Archive operations are disabled',
      });
    }

    if (!sources || !Array.isArray(sources) || sources.length === 0) {
      return res.status(400).json({
        error: 'sources array is required and must not be empty',
      });
    }

    if (!archive_path || !format) {
      return res.status(400).json({
        error: 'archive_path and format are required',
      });
    }

    // Create task for archive creation (async operation)
    const task = await Tasks.create({
      zone_name: 'filesystem',
      operation: 'file_archive_create',
      priority: TaskPriority.LOW,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        sources,
        archive_path,
        format,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Archive creation task created for ${sources.length} items`,
      task_id: task.id,
      sources,
      archive_path,
      format,
    });
  } catch (error) {
    log.api.error('Error creating archive task', {
      error: error.message,
      stack: error.stack,
      sources_count: sources?.length,
      archive_path,
      format,
    });

    if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
      return res.status(403).json({ error: error.message });
    }

    return res.status(500).json({
      error: 'Failed to create archive task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /filesystem/archive/extract:
 *   post:
 *     summary: Extract archive
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
 *               - archive_path
 *               - extract_path
 *             properties:
 *               archive_path:
 *                 type: string
 *                 description: Archive file path to extract
 *                 example: "/home/user/backup.tar.gz"
 *               extract_path:
 *                 type: string
 *                 description: Directory to extract files into
 *                 example: "/home/user/extracted"
 *     responses:
 *       202:
 *         description: Archive extraction task created successfully
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Access forbidden
 *       500:
 *         description: Failed to create extraction task
 */
export const extractArchiveTask = async (req, res) => {
  const { archive_path, extract_path } = req.body;

  try {
    const fileBrowserConfig = config.getFileBrowser();

    if (!fileBrowserConfig?.enabled || !fileBrowserConfig.archive?.enabled) {
      return res.status(503).json({
        error: 'Archive operations are disabled',
      });
    }

    if (!archive_path || !extract_path) {
      return res.status(400).json({
        error: 'archive_path and extract_path are required',
      });
    }

    // Create task for archive extraction (async operation)
    const task = await Tasks.create({
      zone_name: 'filesystem',
      operation: 'file_archive_extract',
      priority: TaskPriority.LOW,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        archive_path,
        extract_path,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Archive extraction task created for '${path.basename(archive_path)}'`,
      task_id: task.id,
      archive_path,
      extract_path,
    });
  } catch (error) {
    log.api.error('Error creating extraction task', {
      error: error.message,
      stack: error.stack,
      archive_path,
      extract_path,
    });

    if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
      return res.status(403).json({ error: error.message });
    }

    return res.status(500).json({
      error: 'Failed to create extraction task',
      details: error.message,
    });
  }
};
