/**
 * @fileoverview Provisioner package registry endpoints (D14 provisioner-registry surface)
 * @description The SHI-format package registry: /provisioning/provisioners* — list, inspect,
 * import (task-queued: folder | archive | git), and delete families or versions no machine
 * references. Wire shapes shared with the Go agent.
 */

import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import {
  listCollections,
  getCollection,
  getPackageVersion,
  deleteCollection,
  deletePackageVersion,
  refreshAllRoleSpecs,
} from '../../lib/ProvisionerRegistry.js';

const provisionerReferences = async (name, version = '') => {
  const zones = await Zones.findAll();
  const references = [];
  for (const zone of zones) {
    let zoneConfig = zone.configuration;
    if (typeof zoneConfig === 'string') {
      try {
        zoneConfig = JSON.parse(zoneConfig);
      } catch {
        continue;
      }
    }
    const ref = zoneConfig?.provisioner_ref;
    if (!ref || ref.name !== name) {
      continue;
    }
    if (version && ref.version !== version) {
      continue;
    }
    references.push(zone.name);
  }
  return references;
};

/**
 * @swagger
 * /provisioning/provisioners:
 *   get:
 *     summary: List provisioner packages
 *     description: Every package family in the registry, versions newest first.
 *     tags: [Provisioner Registry]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Package families with version metadata
 */
export const listProvisioners = (req, res) => {
  void req;
  try {
    const provisioners = listCollections();
    return res.json({ provisioners, total: provisioners.length });
  } catch (error) {
    log.api.error('Failed to list provisioners', { error: error.message });
    return res.status(500).json({ error: 'Failed to retrieve provisioners' });
  }
};

/**
 * @swagger
 * /provisioning/provisioners/{name}:
 *   get:
 *     summary: Get provisioner package details
 *     tags: [Provisioner Registry]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: One package family with its full version metadata
 *       404:
 *         description: Provisioner not found
 */
export const getProvisionerDetails = (req, res) => {
  try {
    const collection = getCollection(req.params.name);
    if (!collection) {
      return res.status(404).json({ error: 'Provisioner not found' });
    }
    return res.json(collection);
  } catch (error) {
    log.api.error('Failed to get provisioner', { name: req.params.name, error: error.message });
    return res.status(500).json({ error: 'Failed to retrieve provisioner' });
  }
};

/**
 * @swagger
 * /provisioning/provisioners/{name}/versions/{version}:
 *   get:
 *     summary: Get one provisioner package version
 *     description: The version's full provisioner.yml — metadata.roles and configuration.basicFields/advancedFields drive the machine-create forms.
 *     tags: [Provisioner Registry]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: version
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: One package version manifest (role_specs carries the cached per-role argument specs)
 *       404:
 *         description: Provisioner or version not found
 */
export const getProvisionerVersion = (req, res) => {
  try {
    if (!getCollection(req.params.name)) {
      return res.status(404).json({ error: 'Provisioner not found' });
    }
    const version = getPackageVersion(req.params.name, req.params.version);
    if (!version) {
      return res.status(404).json({ error: 'Provisioner version not found' });
    }
    return res.json(version);
  } catch (error) {
    log.api.error('Failed to get provisioner version', {
      name: req.params.name,
      error: error.message,
    });
    return res.status(500).json({ error: 'Failed to retrieve provisioner version' });
  }
};

/**
 * @swagger
 * /provisioning/provisioners/refresh-specs:
 *   post:
 *     summary: Re-derive every version's role-specs cache
 *     description: |
 *       Walks each registry version's shipped roles and rebuilds role-specs.yml
 *       from their meta/argument_specs.yml — the manual refresh for
 *       hand-dropped packages and updated specs (imports rebuild it
 *       automatically).
 *     tags: [Provisioner Registry]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Per-version refresh summary
 */
export const refreshProvisionerSpecs = (req, res) => {
  try {
    const refreshed = refreshAllRoleSpecs();
    log.api.info('Provisioner role-specs refreshed', {
      versions: refreshed.length,
      user: req.entity.name,
    });
    return res.json({ success: true, refreshed, total: refreshed.length });
  } catch (error) {
    log.api.error('Failed to refresh role specs', { error: error.message });
    return res.status(500).json({ error: 'Failed to refresh role specs' });
  }
};

/**
 * @swagger
 * /provisioning/provisioners/import:
 *   post:
 *     summary: Import a provisioner package
 *     description: Queues a provisioner_import task. Paths name locations on the agent host.
 *     tags: [Provisioner Registry]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [source_type]
 *             properties:
 *               source_type:
 *                 type: string
 *                 enum: [folder, archive, git]
 *               path:
 *                 type: string
 *                 description: Agent-host path (folder and archive imports)
 *               url:
 *                 type: string
 *                 description: http(s) git repository URL (git imports)
 *               branch:
 *                 type: string
 *     responses:
 *       202:
 *         description: Import task queued
 *       400:
 *         description: Invalid import request
 */
export const importProvisioner = async (req, res) => {
  try {
    const { source_type, path: sourcePath, url, branch } = req.body || {};
    if (!['folder', 'archive', 'git'].includes(source_type)) {
      return res.status(400).json({ error: 'source_type must be "folder", "archive", or "git"' });
    }
    if (['folder', 'archive'].includes(source_type) && !sourcePath) {
      return res.status(400).json({ error: `path is required for ${source_type} imports` });
    }
    if (source_type === 'git' && !url) {
      return res.status(400).json({ error: 'url must be an http(s) git repository URL' });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'provisioner_import',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: JSON.stringify({ source_type, path: sourcePath, url, branch }),
    });

    return res.status(202).json({
      success: true,
      task_id: task.id,
      source_type,
      status: 'pending',
      message: 'Provisioner import task queued successfully',
    });
  } catch (error) {
    log.api.error('Failed to queue provisioner import', { error: error.message });
    return res.status(500).json({ error: 'Failed to queue import task' });
  }
};

/**
 * @swagger
 * /provisioning/provisioners/{name}:
 *   delete:
 *     summary: Delete a provisioner package family
 *     tags: [Provisioner Registry]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Deleted
 *       404:
 *         description: Provisioner not found
 *       409:
 *         description: Referenced by existing machines
 */
export const deleteProvisioner = async (req, res) => {
  try {
    const { name } = req.params;
    if (!getCollection(name)) {
      return res.status(404).json({ error: 'Provisioner not found' });
    }
    const references = await provisionerReferences(name);
    if (references.length > 0) {
      return res.status(409).json({
        error: 'Provisioner is referenced by existing machines and cannot be deleted',
        machines: references,
      });
    }
    deleteCollection(name);
    return res.json({ success: true, message: `Provisioner ${name} deleted successfully` });
  } catch (error) {
    log.api.error('Failed to delete provisioner', { name: req.params.name, error: error.message });
    return res.status(500).json({ error: 'Failed to delete provisioner' });
  }
};

/**
 * @swagger
 * /provisioning/provisioners/{name}/versions/{version}:
 *   delete:
 *     summary: Delete one provisioner package version
 *     tags: [Provisioner Registry]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: version
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Deleted
 *       404:
 *         description: Provisioner or version not found
 *       409:
 *         description: Referenced by existing machines
 */
export const deleteProvisionerVersion = async (req, res) => {
  try {
    const { name, version } = req.params;
    if (!getCollection(name)) {
      return res.status(404).json({ error: 'Provisioner not found' });
    }
    const entry = getPackageVersion(name, version);
    if (!entry) {
      return res.status(404).json({ error: 'Provisioner version not found' });
    }
    const references = await provisionerReferences(name, entry.version);
    if (references.length > 0) {
      return res.status(409).json({
        error: 'Provisioner is referenced by existing machines and cannot be deleted',
        machines: references,
      });
    }
    deletePackageVersion(name, version);
    return res.json({
      success: true,
      message: `Provisioner ${name}/${entry.version} deleted successfully`,
    });
  } catch (error) {
    log.api.error('Failed to delete provisioner version', {
      name: req.params.name,
      error: error.message,
    });
    return res.status(500).json({ error: 'Failed to delete provisioner version' });
  }
};
