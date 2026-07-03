/**
 * @fileoverview Artifact List Controller for Artifact Management
 * @description Handles artifact listing, filtering, and detail retrieval operations
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import config from '../../config/ConfigLoader.js';
import ArtifactStorageLocation from '../../models/ArtifactStorageLocationModel.js';
import Artifact from '../../models/ArtifactModel.js';
import { log } from '../../lib/Logger.js';
import { Op } from 'sequelize';

/**
 * @swagger
 * /artifacts:
 *   get:
 *     summary: List artifacts
 *     description: Retrieves artifacts with optional filtering and pagination
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [iso, image, provisioning]
 *         description: Filter by artifact type
 *       - in: query
 *         name: storage_path_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by storage location
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search in filenames
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of results
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of results to skip
 *       - in: query
 *         name: sort_by
 *         schema:
 *           type: string
 *           enum: [filename, size, discovered_at]
 *           default: filename
 *         description: Sort criteria
 *       - in: query
 *         name: sort_order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: asc
 *         description: Sort order
 *     responses:
 *       200:
 *         description: Artifacts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 artifacts:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Artifact'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *                     has_more:
 *                       type: boolean
 *       500:
 *         description: Failed to retrieve artifacts
 */
export const listArtifacts = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const {
      type,
      storage_path_id,
      search,
      limit = 50,
      offset = 0,
      sort_by = 'filename',
      sort_order = 'asc',
    } = req.query;

    const whereClause = {};

    if (type) {
      whereClause.file_type = type;
    }
    if (storage_path_id) {
      whereClause.storage_location_id = storage_path_id;
    }
    if (search) {
      whereClause.filename = { [Op.like]: `%${search}%` };
    }

    // Build order clause
    const orderField = ['filename', 'size', 'discovered_at'].includes(sort_by)
      ? sort_by
      : 'filename';
    const orderDirection = sort_order.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const artifacts = await Artifact.findAll({
      where: whereClause,
      include: [
        {
          model: ArtifactStorageLocation,
          as: 'storage_location',
          attributes: ['id', 'name', 'path', 'type'],
        },
      ],
      order: [[orderField, orderDirection]],
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    const total = await Artifact.count({ where: whereClause });

    return res.json({
      artifacts,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        has_more: parseInt(offset) + parseInt(limit) < total,
      },
    });
  } catch (error) {
    log.api.error('Error listing artifacts', {
      error: error.message,
      stack: error.stack,
      query_params: req.query,
    });
    return res.status(500).json({
      error: 'Failed to retrieve artifacts',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /artifacts/iso:
 *   get:
 *     summary: List ISO artifacts
 *     description: Convenience endpoint to list only ISO artifacts
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: storage_path_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by storage location
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search in filenames
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of results
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of results to skip
 *     responses:
 *       200:
 *         description: ISO artifacts retrieved successfully
 *       500:
 *         description: Failed to retrieve artifacts
 */
export const listISOArtifacts = (req, res) => {
  req.query.type = 'iso';
  return listArtifacts(req, res);
};

/**
 * @swagger
 * /artifacts/image:
 *   get:
 *     summary: List image artifacts
 *     description: Convenience endpoint to list only image artifacts
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: storage_path_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by storage location
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search in filenames
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of results
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of results to skip
 *     responses:
 *       200:
 *         description: Image artifacts retrieved successfully
 *       500:
 *         description: Failed to retrieve artifacts
 */
export const listImageArtifacts = (req, res) => {
  req.query.type = 'image';
  return listArtifacts(req, res);
};

/**
 * @swagger
 * /artifacts/{id}:
 *   get:
 *     summary: Get artifact details
 *     description: Retrieves detailed information about a specific artifact
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
 *         description: Artifact details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Artifact'
 *       404:
 *         description: Artifact not found
 *       500:
 *         description: Failed to retrieve artifact details
 */
export const getArtifactDetails = async (req, res) => {
  try {
    const { id } = req.params;

    const artifact = await Artifact.findByPk(id, {
      include: [
        {
          model: ArtifactStorageLocation,
          as: 'storage_location',
          attributes: ['id', 'name', 'path', 'type'],
        },
      ],
    });

    if (!artifact) {
      return res.status(404).json({
        error: 'Artifact not found',
      });
    }

    return res.json(artifact);
  } catch (error) {
    log.api.error('Error getting artifact details', {
      error: error.message,
      stack: error.stack,
      id: req.params.id,
    });
    return res.status(500).json({
      error: 'Failed to retrieve artifact details',
      details: error.message,
    });
  }
};
