/**
 * @fileoverview Upload Controller for Artifact Management
 * @description Handles artifact upload preparation and processing operations
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import config from '../../config/ConfigLoader.js';
import ArtifactStorageLocation from '../../models/ArtifactStorageLocationModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log, createTimer, createRequestLogger } from '../../lib/Logger.js';
import yj from 'yieldable-json';

/**
 * @swagger
 * /artifacts/upload/prepare:
 *   post:
 *     summary: Prepare artifact upload
 *     description: Creates an upload task and returns upload URL for efficient large file handling
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
 *               - filename
 *               - size
 *               - storage_path_id
 *             properties:
 *               filename:
 *                 type: string
 *                 description: Original filename
 *                 example: "ubuntu-22.04-server-amd64.iso"
 *               size:
 *                 type: integer
 *                 format: int64
 *                 description: File size in bytes
 *                 example: 4294967296
 *               storage_path_id:
 *                 type: string
 *                 format: uuid
 *                 description: Target storage location ID
 *               checksum:
 *                 type: string
 *                 description: Expected checksum for verification
 *               checksum_algorithm:
 *                 type: string
 *                 enum: [md5, sha1, sha256]
 *                 default: sha256
 *                 description: Checksum algorithm
 *               overwrite_existing:
 *                 type: boolean
 *                 default: false
 *                 description: Whether to overwrite existing files
 *     responses:
 *       200:
 *         description: Upload prepared successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 task_id:
 *                   type: string
 *                   format: uuid
 *                 upload_url:
 *                   type: string
 *                 expires_at:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Invalid request
 *       404:
 *         description: Storage location not found
 */
export const prepareArtifactUpload = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const {
      filename,
      size,
      storage_path_id,
      checksum,
      checksum_algorithm = 'sha256',
      overwrite_existing = false,
    } = req.body;

    if (!filename || !size || !storage_path_id) {
      return res.status(400).json({
        error: 'filename, size, and storage_path_id are required',
      });
    }

    // Check file size limit
    const maxUploadSize = (artifactConfig.security?.max_upload_size_gb || 50) * 1024 * 1024 * 1024;
    if (size > maxUploadSize) {
      return res.status(400).json({
        error: `File size ${Math.round(size / 1024 / 1024)}MB exceeds maximum upload size of ${artifactConfig.security?.max_upload_size_gb || 50}GB`,
      });
    }

    // Verify storage location exists and is enabled
    const storageLocation = await ArtifactStorageLocation.findByPk(storage_path_id);
    if (!storageLocation) {
      return res.status(404).json({
        error: 'Storage location not found',
      });
    }

    if (!storageLocation.enabled) {
      return res.status(400).json({
        error: 'Storage location is disabled',
      });
    }

    // Create upload processing task (prepared status prevents TaskQueue from processing before upload)
    const task = await Tasks.create({
      zone_name: 'artifact',
      operation: 'artifact_upload',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'prepared',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            original_name: filename,
            size: parseInt(size),
            storage_location_id: storage_path_id,
            checksum,
            checksum_algorithm,
            overwrite_existing,
            upload_prepared: true,
          },
          (err, result) => {
            if (err) {
              return reject(err);
            }
            return resolve(result);
          }
        );
      }),
    });

    // Generate upload URL and expiration
    const uploadUrl = `/artifacts/upload/${task.id}`;
    const sessionTimeoutHours = artifactConfig.security?.upload_session_timeout_hours || 2;
    const expiresAt = new Date(Date.now() + sessionTimeoutHours * 60 * 60 * 1000);

    log.artifact.info('Upload prepared successfully', {
      task_id: task.id,
      filename,
      size_mb: Math.round(size / 1024 / 1024),
      storage_location: storageLocation.name,
      expires_at: expiresAt,
    });

    return res.json({
      success: true,
      task_id: task.id,
      upload_url: uploadUrl,
      expires_at: expiresAt.toISOString(),
      storage_location: {
        id: storageLocation.id,
        name: storageLocation.name,
        path: storageLocation.path,
      },
    });
  } catch (error) {
    const { filename, size, storage_path_id } = req.body;
    log.api.error('Error preparing upload', {
      error: error.message,
      stack: error.stack,
      filename,
      size,
      storage_path_id,
    });
    return res.status(500).json({
      error: 'Failed to prepare upload',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /artifacts/upload/{taskId}:
 *   post:
 *     summary: Upload artifact file to prepared task
 *     description: Upload file directly to final storage location using prepared task
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Upload task ID from prepare endpoint
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Artifact file to upload
 *     responses:
 *       202:
 *         description: File uploaded successfully, processing started
 *       400:
 *         description: Invalid upload or task
 *       404:
 *         description: Task not found
 *       413:
 *         description: File too large
 *       500:
 *         description: Upload failed
 */
export const uploadArtifactToTask = async (req, res) => {
  const requestId = `artifact-upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const timer = createTimer('artifact_upload');
  const requestLogger = createRequestLogger(requestId, req);

  try {
    const artifactConfig = config.getArtifactStorage();
    if (!artifactConfig?.enabled) {
      requestLogger.error(503, 'Artifact storage disabled');
      return res.status(503).json({ error: 'Artifact storage is disabled' });
    }

    const { taskId } = req.params;
    const { getAndValidateUploadTask } = await import('./utils/UploadHelpers.js');
    const task = await getAndValidateUploadTask(taskId, requestId);
    const taskMetadata = JSON.parse(task.metadata);

    const { getAndValidateStorageLocation } = await import('./utils/ValidationHelpers.js');
    const storageLocation = await getAndValidateStorageLocation(
      taskMetadata.storage_location_id,
      requestId
    );

    const maxUploadSizeBytes =
      (artifactConfig.security?.max_upload_size_gb || 50) * 1024 * 1024 * 1024;
    const { configureMulter } = await import('./utils/UploadHelpers.js');
    const upload = configureMulter(storageLocation, maxUploadSizeBytes, requestId);

    return upload(req, res, async uploadError => {
      if (uploadError) {
        requestLogger.error(400, `Upload failed: ${uploadError.message}`);
        return res.status(400).json({
          error: 'File upload failed',
          details: uploadError.message,
        });
      }

      if (!req.file) {
        requestLogger.error(400, 'No file uploaded');
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const finalPath = req.file.path;
      const updatedMetadata = {
        ...taskMetadata,
        final_path: finalPath,
        original_name: req.file.originalname,
        size: req.file.size,
        upload_completed: true,
      };

      await task.update({
        metadata: await new Promise((resolve, reject) => {
          yj.stringifyAsync(updatedMetadata, (err, result) => {
            if (err) {
              return reject(err);
            }
            return resolve(result);
          });
        }),
        status: 'pending',
      });

      timer.end({
        filename: req.file.originalname,
        fileSize: req.file.size,
      });

      requestLogger.success(202, {
        filename: req.file.originalname,
        fileSize: req.file.size,
        task_id: taskId,
      });

      return res.status(202).json({
        success: true,
        message: `Upload completed for '${req.file.originalname}'`,
        task_id: taskId,
        file: {
          name: req.file.originalname,
          size: req.file.size,
          final_location: finalPath,
        },
      });
    });
  } catch (error) {
    timer.end({ error: error.message });
    requestLogger.error(500, error.message);
    log.api.error('Artifact upload failed', {
      requestId,
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to process upload', details: error.message });
  }
};
