/**
 * @fileoverview File Operations Controller for Artifact Management
 * @description Handles artifact file operations (move, copy, delete)
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import config from '../../config/ConfigLoader.js';
import Artifact from '../../models/ArtifactModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import { stringifyAsync } from '../../lib/AsyncJson.js';

/**
 * @swagger
 * /artifacts/{id}/move:
 *   post:
 *     summary: Move artifact to another storage location
 *     description: Creates a task to move an artifact to a different storage location
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Artifact ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - destination_storage_location_id
 *             properties:
 *               destination_storage_location_id:
 *                 type: string
 *                 format: uuid
 *                 description: ID of the destination storage location
 *     responses:
 *       202:
 *         description: Move task created successfully
 *       400:
 *         description: Invalid request parameters
 *       404:
 *         description: Artifact or storage location not found
 */
export const moveArtifact = async (req, res) => {
  try {
    const { id } = req.params;
    const { destination_storage_location_id } = req.body;

    if (!destination_storage_location_id) {
      return res.status(400).json({ error: 'destination_storage_location_id is required' });
    }

    const task = await Tasks.create({
      zone_name: 'artifact',
      operation: 'artifact_move',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        artifact_id: id,
        destination_storage_location_id,
      }),
    });

    return res.status(202).json({
      success: true,
      message: 'Artifact move task created successfully.',
      task_id: task.id,
    });
  } catch (error) {
    log.api.error('Error creating artifact move task', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to create artifact move task' });
  }
};

/**
 * @swagger
 * /artifacts/{id}/copy:
 *   post:
 *     summary: Copy artifact to another storage location
 *     description: Creates a task to copy an artifact to a different storage location
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Artifact ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - destination_storage_location_id
 *             properties:
 *               destination_storage_location_id:
 *                 type: string
 *                 format: uuid
 *                 description: ID of the destination storage location
 *     responses:
 *       202:
 *         description: Copy task created successfully
 *       400:
 *         description: Invalid request parameters
 *       404:
 *         description: Artifact or storage location not found
 */
export const copyArtifact = async (req, res) => {
  try {
    const { id } = req.params;
    const { destination_storage_location_id } = req.body;

    if (!destination_storage_location_id) {
      return res.status(400).json({ error: 'destination_storage_location_id is required' });
    }

    const task = await Tasks.create({
      zone_name: 'artifact',
      operation: 'artifact_copy',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        artifact_id: id,
        destination_storage_location_id,
      }),
    });

    return res.status(202).json({
      success: true,
      message: 'Artifact copy task created successfully.',
      task_id: task.id,
    });
  } catch (error) {
    log.api.error('Error creating artifact copy task', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to create artifact copy task' });
  }
};

/**
 * @swagger
 * /artifacts/files:
 *   delete:
 *     summary: Delete artifact files
 *     description: Creates a task to delete specific artifact files
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - artifact_ids
 *             properties:
 *               artifact_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *                 description: List of artifact IDs to delete
 *               delete_files:
 *                 type: boolean
 *                 default: true
 *                 description: Whether to delete actual files from disk
 *               force:
 *                 type: boolean
 *                 default: false
 *                 description: Force deletion even if errors occur
 *     responses:
 *       202:
 *         description: Deletion task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create deletion task
 */
export const deleteArtifacts = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const { artifact_ids, delete_files = true, force = false } = req.body;

    if (!artifact_ids || !Array.isArray(artifact_ids) || artifact_ids.length === 0) {
      return res.status(400).json({
        error: 'artifact_ids array is required and must not be empty',
      });
    }

    // Validate that artifacts exist
    const artifacts = await Artifact.findAll({
      where: { id: artifact_ids },
      attributes: ['id', 'filename', 'size'],
    });

    if (artifacts.length === 0) {
      return res.status(400).json({
        error: 'No artifacts found for the provided IDs',
      });
    }

    if (artifacts.length !== artifact_ids.length) {
      const foundIds = artifacts.map(a => a.id);
      const missingIds = artifact_ids.filter(id => !foundIds.includes(id));
      log.artifact.warn('Some artifact IDs not found', {
        requested_count: artifact_ids.length,
        found_count: artifacts.length,
        missing_ids: missingIds,
      });
    }

    // Create deletion task
    const task = await Tasks.create({
      zone_name: 'artifact',
      operation: 'artifact_delete_file',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        artifact_ids: artifacts.map(a => a.id),
        delete_files,
        force,
      }),
    });

    log.artifact.info('Artifact deletion task created', {
      task_id: task.id,
      artifact_count: artifacts.length,
      delete_files,
      force,
    });

    return res.status(202).json({
      success: true,
      message: `Deletion task created for ${artifacts.length} artifact(s)`,
      task_id: task.id,
      artifacts: artifacts.map(a => ({
        id: a.id,
        filename: a.filename,
        size: a.size,
      })),
      delete_files,
    });
  } catch (error) {
    log.api.error('Error creating artifact deletion task', {
      error: error.message,
      stack: error.stack,
      artifact_ids: req.body.artifact_ids,
    });
    return res.status(500).json({
      error: 'Failed to create deletion task',
      details: error.message,
    });
  }
};
