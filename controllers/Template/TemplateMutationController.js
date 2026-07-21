/**
 * @fileoverview Template Mutation Controller for Zoneweaver Agent
 * @description Handles initiating template download, delete, publish, export, and move tasks
 */

import Template from '../../models/TemplateModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { stringifyAsync } from '../../lib/AsyncJson.js';
import { log } from '../../lib/Logger.js';
import { findSourceConfig, findDefaultSourceConfig } from '../../lib/TemplateRegistryUtils.js';

/**
 * @swagger
 * /templates/pull:
 *   post:
 *     summary: Download template
 *     description: |
 *       Downloads a template from a remote source (async task). Only
 *       organization, box_name, and version are required (the Go agent's
 *       contract) — source_name defaults to the source flagged default,
 *       provider defaults to "zone", architecture defaults to "amd64";
 *       explicit values win.
 *     tags: [Template Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - organization
 *               - box_name
 *               - version
 *             properties:
 *               source_name:
 *                 type: string
 *                 description: Registry source name (defaults to the default-flagged source)
 *               organization:
 *                 type: string
 *               box_name:
 *                 type: string
 *               version:
 *                 type: string
 *               provider:
 *                 type: string
 *                 default: zone
 *               architecture:
 *                 type: string
 *                 default: amd64
 *     responses:
 *       202:
 *         description: Download task created
 */
export const downloadTemplate = async (req, res) => {
  const {
    source_name,
    organization,
    box_name,
    version,
    provider = 'zone',
    architecture = 'amd64',
  } = req.body;

  try {
    // Basic validation — source/provider/architecture default (Go parity)
    if (!organization || !box_name || !version) {
      return res.status(400).json({ error: 'organization, box_name, and version are required' });
    }

    // Download-honesty rule (shared with the Go agent): the registry download
    // URL embeds the version verbatim, so a non-specific version is a
    // guaranteed 404 — refuse it here instead of failing in the task.
    if (version === 'latest') {
      return res.status(400).json({
        error: "version 'latest' is not downloadable — resolve a concrete version first",
        hint: 'GET /templates/remote/{sourceName}/{org}/{boxName} lists concrete versions',
      });
    }

    // Resolve the source: explicit name wins, else the default-flagged source
    const sourceConfig = source_name ? findSourceConfig(source_name) : findDefaultSourceConfig();
    if (!sourceConfig) {
      return res.status(400).json({
        error: source_name
          ? `Template source '${source_name}' not found or disabled`
          : 'No source_name given and no template source is flagged default — set default: true on a source or name one explicitly',
      });
    }
    const resolvedSourceName = sourceConfig.name;

    // Check if already exists locally
    const existing = await Template.findOne({
      where: {
        source_name: resolvedSourceName,
        organization,
        box_name,
        version,
        provider,
        architecture,
      },
    });
    if (existing) {
      return res.status(409).json({
        error: 'Template already exists locally',
        template_id: existing.id,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'template_download',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        source_name: resolvedSourceName,
        organization,
        box_name,
        version,
        provider,
        architecture,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Download task created for ${organization}/${box_name} v${version}`,
      task_id: task.id,
    });
  } catch (error) {
    log.api.error('Error creating template download task', { error: error.message });
    return res.status(500).json({ error: 'Failed to create download task' });
  }
};

/**
 * @swagger
 * /templates/{templateId}:
 *   delete:
 *     summary: Delete local template
 *     description: Deletes a locally stored template and its ZFS dataset (async task)
 *     tags: [Template Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: templateId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       202:
 *         description: Delete task created
 *       404:
 *         description: Template not found
 */
export const deleteLocalTemplate = async (req, res) => {
  const { templateId } = req.params;

  try {
    const template = await Template.findByPk(templateId);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'template_delete',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        template_id: templateId,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Delete task created for template ${template.box_name}`,
      task_id: task.id,
    });
  } catch (error) {
    log.api.error('Error creating template delete task', { error: error.message });
    return res.status(500).json({ error: 'Failed to create delete task' });
  }
};

/**
 * @swagger
 * /templates/publish:
 *   post:
 *     summary: Publish template to registry
 *     description: Uploads a zone (via export) or existing .box file to a registry (async task)
 *     tags: [Template Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - source_name
 *               - organization
 *               - box_name
 *               - version
 *             properties:
 *               machine_name:
 *                 type: string
 *                 description: Name of the machine to export and publish (Required if box_path not set)
 *               box_path:
 *                 type: string
 *                 description: Path to existing .box file to publish (Required if machine_name not set)
 *               source_name:
 *                 type: string
 *                 description: Target registry source name
 *               organization:
 *                 type: string
 *                 description: Target organization
 *               box_name:
 *                 type: string
 *                 description: Target box name
 *               version:
 *                 type: string
 *                 description: Version number
 *               description:
 *                 type: string
 *                 description: Box/Version description
 *               snapshot_name:
 *                 type: string
 *                 description: Optional existing snapshot to use
 *     responses:
 *       202:
 *         description: Publish task created
 */
export const publishTemplate = async (req, res) => {
  const {
    machine_name,
    box_path,
    source_name,
    organization,
    box_name,
    version,
    description,
    snapshot_name,
  } = req.body;

  try {
    if ((!machine_name && !box_path) || !source_name || !organization || !box_name || !version) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Registry credentials live on the configured source ONLY (shared rule
    // with the Go agent: tokens never ride task metadata).
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'template_upload',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        zone_name: machine_name,
        box_path,
        source_name,
        organization,
        box_name,
        version,
        description,
        snapshot_name,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Publish task created for ${machine_name || box_path}`,
      task_id: task.id,
    });
  } catch (error) {
    log.api.error('Error creating template publish task', { error: error.message });
    return res.status(500).json({ error: 'Failed to create publish task' });
  }
};

/**
 * @swagger
 * /templates/export:
 *   post:
 *     summary: Export machine to local template
 *     description: Exports a machine (zone) to a local .box file without uploading (async task)
 *     tags: [Template Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - machine_name
 *             properties:
 *               machine_name:
 *                 type: string
 *               filename:
 *                 type: string
 *                 description: Optional custom filename
 *     responses:
 *       202:
 *         description: Export task created
 */
export const exportTemplate = async (req, res) => {
  const { machine_name, filename, snapshot_name } = req.body;

  try {
    if (!machine_name) {
      return res.status(400).json({ error: 'machine_name is required' });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'template_export',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: JSON.stringify({ zone_name: machine_name, filename, snapshot_name }),
    });

    return res.status(202).json({
      success: true,
      message: `Export task created for zone ${machine_name}`,
      task_id: task.id,
    });
  } catch (error) {
    log.api.error('Error creating template export task', { error: error.message });
    return res.status(500).json({ error: 'Failed to create export task' });
  }
};

/**
 * @swagger
 * /templates/{templateId}/move:
 *   post:
 *     summary: Move template to a different ZFS pool or path
 *     description: |
 *       Moves a template's underlying ZFS dataset to a different pool/location (async task).
 *       Same-pool moves use zfs rename (instant). Cross-pool moves use zfs send/recv.
 *       If the template has dependent ZFS clones (zones created via clone strategy),
 *       cross-pool moves are blocked unless force_promote is set to true.
 *     tags: [Template Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: templateId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               target_pool:
 *                 type: string
 *                 description: Target pool name (API constructs path automatically)
 *               target_path:
 *                 type: string
 *                 description: Explicit target ZFS dataset path (takes precedence over target_pool)
 *               force_promote:
 *                 type: boolean
 *                 default: false
 *                 description: Auto-promote a dependent clone to allow cross-pool move
 *     responses:
 *       202:
 *         description: Move task created
 *       400:
 *         description: Missing required fields or invalid target
 *       404:
 *         description: Template not found
 *       409:
 *         description: Target dataset path conflicts with existing template
 */
export const moveTemplate = async (req, res) => {
  const { templateId } = req.params;
  const { target_pool, target_path, force_promote = false } = req.body || {};

  try {
    if (!target_pool && !target_path) {
      return res.status(400).json({ error: 'Either target_pool or target_path is required' });
    }

    const template = await Template.findByPk(templateId);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Compute target dataset path
    const targetDatasetPath = target_path
      ? target_path
      : `${target_pool}/templates/${template.organization}/${template.box_name}/${template.version}`;

    // Validate source != target
    if (targetDatasetPath === template.dataset_path) {
      return res.status(400).json({
        error: 'Target path is the same as current path',
        current_path: template.dataset_path,
      });
    }

    // Check for DB conflict on target path
    const conflicting = await Template.findOne({
      where: { dataset_path: targetDatasetPath },
    });
    if (conflicting) {
      return res.status(409).json({
        error: 'A template already exists at the target dataset path',
        conflicting_template_id: conflicting.id,
        target_path: targetDatasetPath,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'template_move',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        template_id: templateId,
        target_dataset_path: targetDatasetPath,
        force_promote,
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Move task created for template ${template.box_name} to ${targetDatasetPath}`,
      task_id: task.id,
    });
  } catch (error) {
    log.api.error('Error creating template move task', { error: error.message });
    return res.status(500).json({ error: 'Failed to create move task' });
  }
};
