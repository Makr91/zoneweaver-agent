/**
 * @fileoverview Scan Controller for Artifact Management
 * @description Handles artifact scanning and discovery operations
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import config from '../../config/ConfigLoader.js';
import ArtifactStorageLocation from '../../models/ArtifactStorageLocationModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import yj from 'yieldable-json';

/**
 * @swagger
 * /artifacts/scan:
 *   post:
 *     summary: Scan storage locations
 *     description: Creates a task to scan storage locations for new artifacts
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [iso, image, provisioning]
 *                 description: Scan only locations of this type
 *               storage_path_id:
 *                 type: string
 *                 format: uuid
 *                 description: Scan only this specific location
 *               verify_checksums:
 *                 type: boolean
 *                 default: false
 *                 description: Recalculate and verify checksums
 *               remove_orphaned:
 *                 type: boolean
 *                 default: false
 *                 description: Remove database records for missing files
 *     responses:
 *       202:
 *         description: Scan task created successfully
 *       404:
 *         description: Storage location not found
 *       500:
 *         description: Failed to create scan task
 */
export const scanArtifacts = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const { type, storage_path_id, verify_checksums = false, remove_orphaned = false } = req.body;

    let task;

    if (storage_path_id) {
      // Scan specific location
      const storageLocation = await ArtifactStorageLocation.findByPk(storage_path_id);
      if (!storageLocation) {
        return res.status(404).json({
          error: 'Storage location not found',
        });
      }

      task = await Tasks.create({
        zone_name: 'artifact',
        operation: 'artifact_scan_location',
        priority: TaskPriority.BACKGROUND,
        created_by: req.entity.name,
        status: 'pending',
        metadata: await new Promise((resolve, reject) => {
          yj.stringifyAsync(
            {
              storage_location_id: storage_path_id,
              verify_checksums,
              remove_orphaned,
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

      return res.status(202).json({
        success: true,
        message: `Scan task created for storage location '${storageLocation.name}'`,
        task_id: task.id,
        scope: 'single_location',
        location: {
          id: storageLocation.id,
          name: storageLocation.name,
          path: storageLocation.path,
        },
      });
    }
    // Scan all locations (optionally filtered by type)
    const whereClause = { enabled: true };
    if (type) {
      whereClause.type = type;
    }

    const locationsToScan = await ArtifactStorageLocation.findAll({
      where: whereClause,
      attributes: ['id', 'name', 'type'],
    });

    task = await Tasks.create({
      zone_name: 'artifact',
      operation: 'artifact_scan_all',
      priority: TaskPriority.BACKGROUND,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            verify_checksums,
            remove_orphaned,
            source: 'manual_scan',
            filter_type: type || null,
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

    log.artifact.info('Scan task created', {
      task_id: task.id,
      scope: storage_path_id ? 'single_location' : 'multiple_locations',
      type_filter: type,
      verify_checksums,
      remove_orphaned,
    });

    return res.status(202).json({
      success: true,
      message: `Scan task created for ${locationsToScan.length} storage location(s)${type ? ` (${type} only)` : ''}`,
      task_id: task.id,
      scope: type ? `${type}_locations` : 'all_locations',
      locations_to_scan: locationsToScan.length,
    });
  } catch (error) {
    log.api.error('Error creating scan task', {
      error: error.message,
      stack: error.stack,
      type: req.body.type,
      storage_path_id: req.body.storage_path_id,
    });
    return res.status(500).json({
      error: 'Failed to create scan task',
      details: error.message,
    });
  }
};
