/**
 * @fileoverview Provisioner package import and export endpoints (D14 provisioner-registry surface)
 * @description Package movement: import (folder | archive | git), import-upload (host-to-host
 * receive), refresh-from-source (git re-import), and export (host-to-host send). Wire shapes
 * shared with the Go agent.
 */

import { log } from '../../lib/Logger.js';
import {
  getCollection,
  getPackageVersion,
  readFamilySource,
} from '../../lib/ProvisionerRegistry.js';
import { TOKEN_NAME_PATTERN } from '../TaskManager/ProvisionerImportManager.js';
import { queueRegistryTask } from './utils/RegistryTaskHelper.js';

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
 *               token_name:
 *                 type: string
 *                 description: |
 *                   git imports only — names a git_api_keys entry in the
 *                   global secrets store (PUT /secrets) for private
 *                   repositories. The TOKEN itself never rides the request,
 *                   task metadata, provenance, or logs — the import resolves
 *                   it at run time.
 *     responses:
 *       202:
 *         description: Import task queued
 *       400:
 *         description: Invalid import request
 */
export const importProvisioner = async (req, res) => {
  try {
    const { source_type, path: sourcePath, url, branch, token_name } = req.body || {};
    if (!['folder', 'archive', 'git'].includes(source_type)) {
      return res.status(400).json({ error: 'source_type must be "folder", "archive", or "git"' });
    }
    if (['folder', 'archive'].includes(source_type) && !sourcePath) {
      return res.status(400).json({ error: `path is required for ${source_type} imports` });
    }
    if (source_type === 'git' && !url) {
      return res.status(400).json({ error: 'url must be an http(s) git repository URL' });
    }
    if (token_name && !TOKEN_NAME_PATTERN.test(token_name)) {
      return res.status(400).json({ error: 'token_name contains unsupported characters' });
    }

    const task = await queueRegistryTask(req, 'provisioner_import', {
      source_type,
      path: sourcePath,
      url,
      branch,
      token_name: source_type === 'git' ? token_name : undefined,
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
 * /provisioning/provisioners/import-upload:
 *   post:
 *     summary: Upload a provisioner package archive and import it
 *     description: |
 *       Host-to-host share, receive side (design §7): multipart upload of a
 *       .tar.gz/.tgz/.zip package archive (field "file"), queued as a
 *       provisioner_import task. An optional "checksum" form field (sha256 of
 *       the ARCHIVE) is verified before extraction; the upload is removed
 *       after the import.
 *     tags: [Provisioner Registry]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               checksum:
 *                 type: string
 *                 description: Optional sha256 of the archive, verified before extraction
 *     responses:
 *       202:
 *         description: Import task queued
 *       400:
 *         description: No file or not an archive
 */
export const importProvisionerUpload = async (req, res) => {
  try {
    if (!req.file?.path) {
      return res
        .status(400)
        .json({ error: 'a package archive is required (multipart field "file")' });
    }
    const checksum = typeof req.body?.checksum === 'string' ? req.body.checksum.trim() : '';

    const task = await queueRegistryTask(req, 'provisioner_import', {
      source_type: 'archive',
      path: req.file.path,
      checksum: checksum || undefined,
      cleanup_source: true,
    });

    return res.status(202).json({
      success: true,
      task_id: task.id,
      filename: req.file.filename,
      size: req.file.size,
      status: 'pending',
      message: 'Provisioner upload received — import task queued',
    });
  } catch (error) {
    log.api.error('Failed to queue provisioner import-upload', { error: error.message });
    return res.status(500).json({ error: 'Failed to queue import task' });
  }
};

/**
 * @swagger
 * /provisioning/provisioners/{name}/refresh-from-source:
 *   post:
 *     summary: Re-import a git-imported family from its recorded source
 *     description: |
 *       Families imported from git record their provenance ({source_type:
 *       git, url, branch?, token_name?} — exposed as `source` on the family
 *       detail/list). This queues the ORDINARY provisioner_import task
 *       against that stored source, replaying token_name for private repos
 *       (the token resolves from the secrets store at run time): existing
 *       versions refuse (immutable, non-clobber), NEW versions land beside
 *       them. Families from folder/archive/catalog imports carry no
 *       provenance and answer 400 (catalog families update through the
 *       catalog).
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
 *       202:
 *         description: Import task queued against the recorded git source
 *       400:
 *         description: Family carries no git provenance
 *       404:
 *         description: Provisioner not found
 */
export const refreshProvisionerFromSource = async (req, res) => {
  try {
    const { name } = req.params;
    if (!getCollection(name)) {
      return res.status(404).json({ error: 'Provisioner not found' });
    }
    const source = readFamilySource(name);
    if (source?.source_type !== 'git' || !source.url) {
      return res.status(400).json({
        error: `${name} carries no git provenance — refresh-from-source works only for git imports (catalog families update through the catalog)`,
      });
    }

    const task = await queueRegistryTask(req, 'provisioner_import', {
      source_type: 'git',
      url: source.url,
      branch: source.branch,
      token_name: source.token_name,
    });

    return res.status(202).json({
      success: true,
      task_id: task.id,
      name,
      source,
      status: 'pending',
      message: `Refresh-from-source import task queued for ${name} (${source.url})`,
    });
  } catch (error) {
    log.api.error('Failed to queue refresh-from-source', {
      name: req.params.name,
      error: error.message,
    });
    return res.status(500).json({ error: 'Failed to queue refresh-from-source task' });
  }
};

/**
 * @swagger
 * /provisioning/provisioners/{name}/versions/{version}/export:
 *   post:
 *     summary: Export a provisioner package version as tar.gz + sha256
 *     description: |
 *       Host-to-host share, send side (design §7, the shared wire): packs ONE
 *       version as a REGISTRY-SHAPED tar.gz (<name>/<version>/… inside the
 *       archive — the receiving import consumes it as-is) under
 *       <registry>/exports, with the ARCHIVE's sha256 in the task output and
 *       a <file>.sha256 sidecar.
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
 *       202:
 *         description: Export task queued
 *       404:
 *         description: Provisioner or version not found
 */
export const exportProvisioner = async (req, res) => {
  try {
    const { name, version } = req.params;
    const entry = getPackageVersion(name, version);
    if (!entry) {
      return res.status(404).json({ error: 'Provisioner version not found' });
    }

    const task = await queueRegistryTask(req, 'provisioner_export', {
      name,
      version: entry.version,
      dir: entry.dir,
    });

    return res.status(202).json({
      success: true,
      task_id: task.id,
      name,
      version: entry.version,
      status: 'pending',
      message: `Export task queued for ${name}/${entry.version}`,
    });
  } catch (error) {
    log.api.error('Failed to queue provisioner export', { error: error.message });
    return res.status(500).json({ error: 'Failed to queue export task' });
  }
};
