/**
 * @fileoverview Template Local Query Controller for Zoneweaver Agent
 * @description Handles listing and retrieval of locally stored templates
 */

import Template from '../../models/TemplateModel.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { snapshotGuid } from '../../lib/DiskSpec.js';
import { log } from '../../lib/Logger.js';

/**
 * Pools holding this template with VERIFIED identity: the origin pool plus
 * every pool carrying a replica whose @ready snapshot GUID matches the
 * origin's (send|recv preserves the guid; snapshots are immutable — equal
 * guid = identical content). Drifted or hand-rolled replicas fail the match
 * and are excluded.
 * @param {string} datasetPath - The template's registered dataset
 * @param {string[]} pools - All pool names on the host
 * @returns {Promise<string[]>} Pools the template is thin-clonable on
 */
const availablePools = async (datasetPath, pools) => {
  const [originPool, ...rest] = datasetPath.split('/');
  const suffix = rest.join('/');
  const originGuid = await snapshotGuid(`${datasetPath}@ready`);
  if (!originGuid) {
    return [originPool];
  }
  const replicas = await Promise.all(
    pools
      .filter(pool => pool !== originPool)
      .map(async pool =>
        (await snapshotGuid(`${pool}/${suffix}@ready`)) === originGuid ? pool : null
      )
  );
  return [originPool, ...replicas.filter(Boolean)];
};

/**
 * @swagger
 * /templates:
 *   get:
 *     summary: List local templates
 *     description: |
 *       Lists all templates downloaded and available locally. Each row carries
 *       `available_pools` — the pools this template can be THIN-CLONED on:
 *       its origin pool plus every pool holding a snapshot-GUID-verified
 *       localized replica (the clone-strategy matrix's membership test; a
 *       selected pool outside the list means copy or localize).
 *     tags: [Template Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of local templates (rows enriched with available_pools)
 */
export const listLocalTemplates = async (req, res) => {
  void req;
  try {
    const templates = await Template.findAll({
      order: [['created_at', 'DESC']],
    });

    const poolsResult = await executeCommand('pfexec zpool list -H -o name');
    const pools = poolsResult.success
      ? poolsResult.output
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean)
      : [];

    const rows = await Promise.all(
      templates.map(async template => ({
        ...template.toJSON(),
        available_pools: await availablePools(template.dataset_path, pools),
      }))
    );

    return res.json({
      templates: rows,
      total: rows.length,
    });
  } catch (error) {
    log.database.error('Error listing local templates', { error: error.message });
    return res.status(500).json({ error: 'Failed to list local templates' });
  }
};

/**
 * @swagger
 * /templates/{templateId}:
 *   get:
 *     summary: Get local template details
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
 *       200:
 *         description: Template details
 *       404:
 *         description: Template not found
 */
export const getLocalTemplate = async (req, res) => {
  const { templateId } = req.params;

  try {
    const template = await Template.findByPk(templateId);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    return res.json(template);
  } catch (error) {
    log.database.error('Error getting local template', { error: error.message });
    return res.status(500).json({ error: 'Failed to retrieve template details' });
  }
};
