/**
 * @fileoverview Provisioner package registry endpoints (D14 provisioner-registry surface)
 * @description The SHI-format package registry: /provisioning/provisioners* — list, inspect,
 * import (task-queued: folder | archive | git), and delete families or versions no machine
 * references. Wire shapes shared with the Go agent.
 */

import { log } from '../../lib/Logger.js';
import {
  listCollections,
  getCollection,
  getPackageVersion,
  deleteCollection,
  deletePackageVersion,
  refreshAllRoleSpecs,
} from '../../lib/ProvisionerRegistry.js';
import {
  getCatalogSources as getConfiguredCatalogSources,
  findCatalogSource,
  fetchCatalog,
  catalogSourceError,
} from '../../lib/ProvisionerCatalog.js';
import { provisionerReferences, queueRegistryTask } from './utils/RegistryTaskHelper.js';

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
 *     description: |
 *       The version's full provisioner.yml. metadata.configuration
 *       {groups, fields} (the field DSL) drives the machine-create form;
 *       metadata.presentation and metadata.forked_from ride verbatim.
 *       role_specs carries the cached per-role argument specs; field_schema
 *       carries the derived answers JSON Schema (2020-12).
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
 * /provisioning/catalog/sources:
 *   get:
 *     summary: List the configured catalog sources
 *     description: The provisioning.catalog_sources entries (STARTcloud default seeded when none configured). Never returns credentials — sources carry none.
 *     tags: [Provisioner Registry]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Catalog sources
 */
export const getCatalogSources = (req, res) => {
  void req;
  const { enabled, sources } = getConfiguredCatalogSources();
  return res.json({
    enabled,
    sources: sources.map(({ name, url, default: isDefault }) => ({
      name,
      url,
      default: Boolean(isDefault),
    })),
  });
};

/**
 * @swagger
 * /provisioning/catalog:
 *   get:
 *     summary: Fetch a provisioner catalog
 *     description: |
 *       Fetches a configured catalog feed (design §7, the HACS model —
 *       format_version 1). ?source= names a provisioning.catalog_sources
 *       entry; unset resolves the default-flagged source (built-in default:
 *       the STARTcloud catalog). Catalogs are ADVISORY — import still
 *       verifies the sha256 after download.
 *     tags: [Provisioner Registry]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: source
 *         schema:
 *           type: string
 *         description: Configured catalog source name (default-flagged source when unset)
 *     responses:
 *       200:
 *         description: The catalog document itself, relayed FLAT (the shared wire — {name, format_version, updated, provisioners[]}; no envelope)
 *       404:
 *         description: No such catalog source (or catalogs disabled)
 *       502:
 *         description: Catalog fetch failed or is not format_version 1
 */
export const getCatalog = async (req, res) => {
  const source = findCatalogSource(req.query.source);
  if (!source) {
    return res.status(404).json({ error: catalogSourceError(req.query.source) });
  }
  try {
    const catalog = await fetchCatalog(source);
    return res.json(catalog);
  } catch (error) {
    log.api.error('Catalog fetch failed', { source: source.url, error: error.message });
    return res.status(502).json({ error: `Catalog fetch failed: ${error.message}` });
  }
};

/**
 * @swagger
 * /provisioning/catalog/install:
 *   post:
 *     summary: Install a provisioner version from a catalog
 *     description: |
 *       Queues a provisioner_catalog_install task (the shared wire): the TASK
 *       fetches the catalog FRESH at run time (stale pins 404 anyway;
 *       published checksums never change), downloads the VERSIONED artifact,
 *       verifies its sha256, then runs the ordinary import path (lint gate +
 *       non-clobber included). Versions are immutable — an already-present
 *       version answers 409 up front.
 *     tags: [Provisioner Registry]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, version]
 *             properties:
 *               source_name:
 *                 type: string
 *                 description: Catalog source name (default-flagged source when unset)
 *               name:
 *                 type: string
 *               version:
 *                 type: string
 *     responses:
 *       202:
 *         description: Catalog install task queued
 *       404:
 *         description: No such catalog source
 *       409:
 *         description: Version already present (immutable)
 */
export const installFromCatalog = async (req, res) => {
  try {
    const { source_name, name, version } = req.body || {};
    if (!name || !version) {
      return res.status(400).json({ error: 'name and version are required' });
    }
    const source = findCatalogSource(source_name);
    if (!source) {
      return res.status(404).json({ error: catalogSourceError(source_name) });
    }
    if (getPackageVersion(name, version)) {
      return res.status(409).json({
        error: `${name}/${version} is already in the registry — versions are immutable`,
      });
    }

    const task = await queueRegistryTask(req, 'provisioner_catalog_install', {
      source_name: source.name,
      name,
      version,
    });

    return res.status(202).json({
      success: true,
      task_id: task.id,
      name,
      version,
      source: source.name,
      status: 'pending',
      message: `Catalog install task queued for ${name}/${version}`,
    });
  } catch (error) {
    log.api.error('Failed to queue catalog install', { error: error.message });
    return res.status(500).json({ error: 'Failed to queue catalog install task' });
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
