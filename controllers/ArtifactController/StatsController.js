/**
 * @fileoverview Stats Controller for Artifact Management
 * @description Handles artifact statistics and service status operations
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import config from '../../config/ConfigLoader.js';
import Tasks from '../../models/TaskModel.js';
import { getArtifactStorageService } from '../ArtifactStorageService.js';
import { log } from '../../lib/Logger.js';
import { Op } from 'sequelize';

/**
 * @swagger
 * /artifacts/stats:
 *   get:
 *     summary: Get artifact statistics
 *     description: Retrieves statistics about artifacts and storage locations
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 by_type:
 *                   type: object
 *                   additionalProperties:
 *                     type: object
 *                     properties:
 *                       count:
 *                         type: integer
 *                       total_size:
 *                         type: integer
 *                       locations:
 *                         type: integer
 *                 storage_locations:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       path:
 *                         type: string
 *                       type:
 *                         type: string
 *                       enabled:
 *                         type: boolean
 *                       file_count:
 *                         type: integer
 *                       total_size:
 *                         type: integer
 *                       last_scan:
 *                         type: string
 *                 recent_activity:
 *                   type: object
 *                   properties:
 *                     downloads_last_24h:
 *                       type: integer
 *                     uploads_last_24h:
 *                       type: integer
 *                     failed_operations_last_24h:
 *                       type: integer
 *       500:
 *         description: Failed to retrieve statistics
 */
export const getArtifactStats = async (req, res) => {
  void req;
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    // Get statistics from service
    const service = getArtifactStorageService();
    const stats = await service.getArtifactStats();

    // Get recent activity from tasks
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const recentTasks = await Tasks.findAll({
      where: {
        operation: {
          [Op.in]: ['artifact_download_url', 'artifact_upload'],
        },
        created_at: { [Op.gte]: yesterday },
      },
      attributes: ['operation', 'status'],
    });

    const recentActivity = {
      downloads_last_24h: recentTasks.filter(
        t => t.operation === 'artifact_download_url' && t.status === 'completed'
      ).length,
      uploads_last_24h: recentTasks.filter(
        t => t.operation === 'artifact_upload' && t.status === 'completed'
      ).length,
      failed_operations_last_24h: recentTasks.filter(t => t.status === 'failed').length,
    };

    return res.json({
      ...stats,
      recent_activity: recentActivity,
    });
  } catch (error) {
    log.api.error('Error getting artifact statistics', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to retrieve statistics',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /artifacts/service/status:
 *   get:
 *     summary: Get artifact storage service status
 *     description: Retrieves current status of the artifact storage service
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Service status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isRunning:
 *                   type: boolean
 *                 isInitialized:
 *                   type: boolean
 *                 config:
 *                   type: object
 *                 stats:
 *                   type: object
 *                 activeIntervals:
 *                   type: object
 *       500:
 *         description: Failed to retrieve service status
 */
export const getArtifactServiceStatus = (req, res) => {
  void req;
  try {
    const service = getArtifactStorageService();
    const status = service.getStatus();

    return res.json(status);
  } catch (error) {
    log.api.error('Error getting artifact service status', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to retrieve service status',
      details: error.message,
    });
  }
};
