/**
 * @fileoverview Storage Path update and delete controllers for Artifact Management
 * @description Update and delete operations for artifact storage paths
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import config from '../../config/ConfigLoader.js';
import ArtifactStorageLocation from '../../models/ArtifactStorageLocationModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import { stringifyAsync } from '../../lib/AsyncJson.js';

/**
 * @swagger
 * /artifacts/storage/paths/{id}:
 *   put:
 *     summary: Update storage path
 *     description: Updates an existing storage path configuration
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
 *         description: Storage location ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Updated display name
 *               enabled:
 *                 type: boolean
 *                 description: Whether to enable/disable this location
 *     responses:
 *       200:
 *         description: Storage path updated successfully
 *       404:
 *         description: Storage path not found
 *       500:
 *         description: Failed to update storage path
 */
export const updateStoragePath = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const { id } = req.params;
    const { name, enabled } = req.body;

    const storageLocation = await ArtifactStorageLocation.findByPk(id);
    if (!storageLocation) {
      return res.status(404).json({
        error: 'Storage path not found',
      });
    }

    const updateData = {};
    if (name !== undefined) {
      updateData.name = name;
    }
    if (enabled !== undefined) {
      updateData.enabled = enabled;
    }

    await storageLocation.update(updateData);

    log.artifact.info('Storage path updated successfully', {
      id,
      name: storageLocation.name,
      enabled: storageLocation.enabled,
      updated_fields: Object.keys(updateData),
    });

    return res.json({
      success: true,
      message: `Storage path '${storageLocation.name}' updated successfully`,
      storage_location: storageLocation,
    });
  } catch (error) {
    log.api.error('Error updating storage path', {
      error: error.message,
      stack: error.stack,
      id: req.params.id,
    });
    return res.status(500).json({
      error: 'Failed to update storage path',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /artifacts/storage/paths/{id}:
 *   delete:
 *     summary: Delete storage path
 *     description: Creates a task to delete storage path and optionally its contents
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
 *         description: Storage location ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               recursive:
 *                 type: boolean
 *                 description: Delete folder contents recursively
 *                 default: true
 *               remove_db_records:
 *                 type: boolean
 *                 description: Remove artifact database records
 *                 default: true
 *               force:
 *                 type: boolean
 *                 description: Force deletion even if errors occur
 *                 default: false
 *     responses:
 *       202:
 *         description: Deletion task created successfully
 *       404:
 *         description: Storage path not found
 *       500:
 *         description: Failed to create deletion task
 */
export const deleteStoragePath = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const { id } = req.params;
    const { recursive = true, remove_db_records = true, force = false } = req.body;

    const storageLocation = await ArtifactStorageLocation.findByPk(id);
    if (!storageLocation) {
      return res.status(404).json({
        error: 'Storage path not found',
      });
    }

    const task = await Tasks.create({
      zone_name: 'artifact',
      operation: 'artifact_delete_folder',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        storage_location_id: id,
        recursive,
        remove_db_records,
        force,
      }),
    });

    log.artifact.info('Storage path deletion task created', {
      task_id: task.id,
      storage_location_id: id,
      name: storageLocation.name,
      path: storageLocation.path,
      recursive,
      remove_db_records,
    });

    return res.status(202).json({
      success: true,
      message: `Deletion task created for storage path '${storageLocation.name}'`,
      task_id: task.id,
      location: {
        id: storageLocation.id,
        name: storageLocation.name,
        path: storageLocation.path,
        file_count: storageLocation.file_count,
      },
    });
  } catch (error) {
    log.api.error('Error creating storage path deletion task', {
      error: error.message,
      stack: error.stack,
      id: req.params.id,
    });
    return res.status(500).json({
      error: 'Failed to create deletion task',
      details: error.message,
    });
  }
};
