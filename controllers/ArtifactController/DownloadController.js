/**
 * @fileoverview Download Controller for Artifact Management
 * @description Handles artifact download from URLs and streaming downloads to clients
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import fs from 'fs';
import path from 'path';
import config from '../../config/ConfigLoader.js';
import ArtifactStorageLocation from '../../models/ArtifactStorageLocationModel.js';
import Artifact from '../../models/ArtifactModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import yj from 'yieldable-json';

/**
 * @swagger
 * /artifacts/download:
 *   post:
 *     summary: Download artifact from URL
 *     description: Creates a task to download an artifact from a URL to specified storage location
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
 *               - url
 *               - storage_path_id
 *             properties:
 *               url:
 *                 type: string
 *                 format: uri
 *                 description: URL to download from
 *                 example: "https://releases.ubuntu.com/22.04/ubuntu-22.04-server-amd64.iso"
 *               storage_path_id:
 *                 type: string
 *                 format: uuid
 *                 description: Target storage location ID
 *               filename:
 *                 type: string
 *                 description: Override filename (optional)
 *                 example: "ubuntu-22.04-server.iso"
 *               checksum:
 *                 type: string
 *                 description: Expected checksum for verification
 *                 example: "abc123def456..."
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
 *       202:
 *         description: Download task created successfully
 *       400:
 *         description: Invalid request parameters
 *       404:
 *         description: Storage location not found
 *       500:
 *         description: Failed to create download task
 */
export const downloadFromUrl = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const {
      url,
      storage_path_id,
      filename,
      checksum,
      checksum_algorithm = 'sha256',
      overwrite_existing = false,
    } = req.body;

    if (!url || !storage_path_id) {
      return res.status(400).json({
        error: 'url and storage_path_id are required',
      });
    }

    // Validate URL
    try {
      new URL(url);
    } catch {
      return res.status(400).json({
        error: 'Invalid URL format',
      });
    }

    // Validate checksum algorithm
    if (!['md5', 'sha1', 'sha256'].includes(checksum_algorithm)) {
      return res.status(400).json({
        error: 'checksum_algorithm must be md5, sha1, or sha256',
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

    // Create download task
    const task = await Tasks.create({
      zone_name: 'artifact',
      operation: 'artifact_download_url',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            url,
            storage_location_id: storage_path_id,
            filename,
            checksum,
            checksum_algorithm,
            overwrite_existing,
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

    // Determine filename for response
    const displayFilename = filename || path.basename(new URL(url).pathname) || 'download';

    log.artifact.info('Download task created', {
      task_id: task.id,
      url,
      storage_location: storageLocation.name,
      filename: displayFilename,
      has_checksum: !!checksum,
    });

    return res.status(202).json({
      success: true,
      message: `Download task created for '${displayFilename}'`,
      task_id: task.id,
      url,
      storage_location: {
        id: storageLocation.id,
        name: storageLocation.name,
        path: storageLocation.path,
      },
      filename: displayFilename,
    });
  } catch (error) {
    const { url, storage_path_id } = req.body;
    log.api.error('Error creating download task', {
      error: error.message,
      stack: error.stack,
      url,
      storage_path_id,
    });
    return res.status(500).json({
      error: 'Failed to create download task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /artifacts/{id}/download:
 *   get:
 *     summary: Download artifact file
 *     description: Stream download an artifact file
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
 *     responses:
 *       200:
 *         description: Artifact file downloaded successfully
 *         content:
 *           application/octet-stream:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Artifact not found
 *       500:
 *         description: Failed to download artifact
 */
export const downloadArtifact = async (req, res) => {
  try {
    const { id } = req.params;

    const artifact = await Artifact.findByPk(id, {
      include: [
        {
          model: ArtifactStorageLocation,
          as: 'storage_location',
          attributes: ['id', 'name', 'path'],
        },
      ],
    });

    if (!artifact) {
      return res.status(404).json({
        error: 'Artifact not found',
      });
    }

    // Verify file exists
    if (!fs.existsSync(artifact.path)) {
      log.artifact.warn('Artifact file not found on disk', {
        artifact_id: id,
        filename: artifact.filename,
        path: artifact.path,
      });
      return res.status(404).json({
        error: 'Artifact file not found on disk',
      });
    }

    // Set headers for download (following FileSystemController pattern)
    res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename}"`);
    res.setHeader('Content-Type', artifact.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', artifact.size);

    log.artifact.info('Streaming artifact download', {
      artifact_id: id,
      filename: artifact.filename,
      size_mb: Math.round(artifact.size / 1024 / 1024),
      client_ip: req.ip,
    });

    // Stream the file (following FileSystemController pattern)
    const readStream = fs.createReadStream(artifact.path);
    readStream.pipe(res);

    readStream.on('error', error => {
      log.artifact.error('Error streaming artifact', {
        error: error.message,
        artifact_id: id,
        path: artifact.path,
      });
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Failed to download artifact',
          details: error.message,
        });
      }
    });

    // Update last_verified timestamp
    artifact.update({ last_verified: new Date() }).catch(updateError => {
      log.artifact.warn('Failed to update last_verified timestamp', {
        artifact_id: id,
        error: updateError.message,
      });
    });

    return undefined;
  } catch (error) {
    log.api.error('Error downloading artifact', {
      error: error.message,
      stack: error.stack,
      id: req.params.id,
    });

    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Failed to download artifact',
        details: error.message,
      });
    }
    return undefined;
  }
};
