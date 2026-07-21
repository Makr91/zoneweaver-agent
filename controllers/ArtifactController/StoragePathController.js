/**
 * @fileoverview Storage Path Controller for Artifact Management
 * @description Handles CRUD operations for artifact storage paths
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import fs from 'fs';
import crypto from 'crypto';
import config from '../../config/ConfigLoader.js';
import ArtifactStorageLocation from '../../models/ArtifactStorageLocationModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import { validatePath, executeCommand } from '../../lib/FileSystemManager.js';
import yj from 'yieldable-json';

/**
 * @swagger
 * /artifacts/storage/paths:
 *   get:
 *     summary: List storage paths
 *     description: Retrieves all configured artifact storage paths with statistics
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [iso, image, provisioning]
 *         description: Filter by storage type
 *       - in: query
 *         name: enabled
 *         schema:
 *           type: boolean
 *         description: Filter by enabled status
 *     responses:
 *       200:
 *         description: Storage paths retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 paths:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ArtifactStorageLocation'
 *                 total_paths:
 *                   type: integer
 *       500:
 *         description: Failed to retrieve storage paths
 */
export const listStoragePaths = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const { type, enabled } = req.query;
    const whereClause = {};

    if (type) {
      whereClause.type = type;
    }
    if (enabled !== undefined) {
      whereClause.enabled = enabled === 'true';
    }

    const paths = await ArtifactStorageLocation.findAll({
      where: whereClause,
      order: [
        ['type', 'ASC'],
        ['name', 'ASC'],
      ],
    });

    const pathsWithStats = await Promise.all(
      paths.map(async storagePath => {
        let diskUsage = null;
        try {
          if (fs.existsSync(storagePath.path)) {
            const dfResult = await executeCommand(`df -h "${storagePath.path}"`);
            if (dfResult.success) {
              const lines = dfResult.output.split('\n');
              if (lines.length > 1) {
                const parts = lines[1].split(/\s+/);
                if (parts.length >= 6) {
                  diskUsage = {
                    filesystem: parts[0],
                    total: parts[1],
                    used: parts[2],
                    available: parts[3],
                    use_percent: parts[4],
                    mount_point: parts[5],
                  };
                }
              }
            }
          }
        } catch {
          log.artifact.warn('Failed to get disk usage', {
            path: storagePath.path,
          });
        }
        return {
          ...storagePath.toJSON(),
          disk_usage: diskUsage,
        };
      })
    );

    return res.json({
      paths: pathsWithStats,
      total_paths: pathsWithStats.length,
    });
  } catch (error) {
    log.api.error('Error listing storage paths', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to retrieve storage paths',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /artifacts/storage/paths:
 *   post:
 *     summary: Add storage path
 *     description: Creates a new artifact storage path and updates configuration
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
 *               - name
 *               - path
 *               - type
 *             properties:
 *               name:
 *                 type: string
 *                 description: Display name for storage location
 *                 example: "Primary ISO Storage"
 *               path:
 *                 type: string
 *                 description: Filesystem path for storage
 *                 example: "/data/isos"
 *               type:
 *                 type: string
 *                 enum: [iso, image, provisioning]
 *                 description: Type of artifacts to store
 *                 example: "iso"
 *               enabled:
 *                 type: boolean
 *                 description: Whether storage location should be enabled
 *                 default: true
 *     responses:
 *       201:
 *         description: Storage path created successfully
 *       400:
 *         description: Invalid request parameters
 *       409:
 *         description: Path already exists
 *       500:
 *         description: Failed to create storage path
 */
export const createStoragePath = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const { name, path: storagePath, type, enabled = true } = req.body;

    if (!name || !storagePath || !type) {
      return res.status(400).json({
        error: 'name, path, and type are required',
      });
    }

    if (!['iso', 'image', 'provisioning'].includes(type)) {
      return res.status(400).json({
        error: 'type must be either "iso", "image", or "provisioning"',
      });
    }

    const validation = validatePath(storagePath);
    if (!validation.valid) {
      return res.status(400).json({
        error: `Invalid storage path: ${validation.error}`,
      });
    }

    const { normalizedPath } = validation;

    const existingPath = await ArtifactStorageLocation.findOne({
      where: { path: normalizedPath },
    });

    if (existingPath) {
      return res.status(409).json({
        error: `Storage path already exists: ${normalizedPath}`,
        existing_location: {
          id: existingPath.id,
          name: existingPath.name,
          type: existingPath.type,
        },
      });
    }

    try {
      await fs.promises.access(normalizedPath);
    } catch (error) {
      try {
        log.artifact.info('Creating storage directory with pfexec', {
          path: normalizedPath,
          name,
          error,
        });

        const mkdirResult = await executeCommand(`pfexec mkdir -p "${normalizedPath}"`);

        if (!mkdirResult.success) {
          throw new Error(`mkdir failed: ${mkdirResult.error}`);
        }

        log.artifact.info('Storage directory created successfully', {
          path: normalizedPath,
          name,
        });
      } catch (mkdirError) {
        return res.status(400).json({
          error: `Cannot create storage directory: ${mkdirError.message}`,
        });
      }
    }

    const configHash = crypto
      .createHash('md5')
      .update(JSON.stringify({ name, path: normalizedPath, type, enabled }))
      .digest('hex');

    const storageLocation = await ArtifactStorageLocation.create({
      name,
      path: normalizedPath,
      type,
      enabled,
      config_hash: configHash,
      file_count: 0,
      total_size: 0,
    });

    try {
      const { updateConfigWithNewPath } = await import('./utils/ConfigHelpers.js');
      await updateConfigWithNewPath({ name, path: normalizedPath, type, enabled });
      log.artifact.info('Storage path added to config.yaml successfully', {
        id: storageLocation.id,
        name,
        path: normalizedPath,
        type,
        enabled,
      });
    } catch (configError) {
      log.artifact.warn('Failed to update config.yaml - path only exists in database', {
        id: storageLocation.id,
        error: configError.message,
      });
    }

    log.artifact.info('Storage path created successfully', {
      id: storageLocation.id,
      name,
      path: normalizedPath,
      type,
      enabled,
    });

    if (enabled) {
      try {
        const scanTask = await Tasks.create({
          zone_name: 'artifact',
          operation: 'artifact_scan_location',
          priority: TaskPriority.BACKGROUND,
          created_by: req.entity.name,
          status: 'pending',
          metadata: await new Promise((resolve, reject) => {
            yj.stringifyAsync(
              {
                storage_location_id: storageLocation.id,
                verify_checksums: false,
                remove_orphaned: false,
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

        log.artifact.info('Initial scan task created for new storage location', {
          task_id: scanTask.id,
          storage_location_id: storageLocation.id,
        });
      } catch (taskError) {
        log.artifact.warn('Failed to create initial scan task', {
          error: taskError.message,
          storage_location_id: storageLocation.id,
        });
      }
    }

    return res.status(201).json({
      success: true,
      message: `Storage path '${name}' created successfully`,
      storage_location: storageLocation,
    });
  } catch (error) {
    const { name, path: storagePath, type } = req.body;
    log.api.error('Error creating storage path', {
      error: error.message,
      stack: error.stack,
      name,
      path: storagePath,
      type,
    });

    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({
        error: 'Storage path already exists',
        details: error.message,
      });
    }

    return res.status(500).json({
      error: 'Failed to create storage path',
      details: error.message,
    });
  }
};
