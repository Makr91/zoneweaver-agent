/**
 * @fileoverview Template Source Controller for Zoneweaver Agent
 * @description Handles template source listing and remote template discovery
 */

import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';
import {
  getRegistryToken,
  createRegistryClient,
  findSourceConfig,
} from '../../lib/TemplateRegistryUtils.js';

/**
 * @swagger
 * /templates/sources:
 *   get:
 *     summary: List configured template sources
 *     tags: [Template Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of enabled template sources
 */
export const listSources = (req, res) => {
  void req;
  try {
    const templateConfig = config.getTemplateSources();
    const sources = (templateConfig?.sources || [])
      .filter(s => s.enabled)
      .map(s => ({
        name: s.name,
        type: s.type,
        url: s.url,
        organization: s.organization,
        verify_ssl: s.verify_ssl,
      }));

    return res.json({ sources });
  } catch (error) {
    log.api.error('Error listing template sources', { error: error.message });
    return res.status(500).json({ error: 'Failed to list template sources' });
  }
};

/**
 * @swagger
 * /templates/remote/{sourceName}:
 *   get:
 *     summary: List remote templates from a source
 *     description: Proxies to the registry's discovery endpoint
 *     tags: [Template Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sourceName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of available templates
 */
export const listRemoteTemplates = async (req, res) => {
  const { sourceName } = req.params;
  const userToken = req.headers['x-registry-token'];

  try {
    const sourceConfig = findSourceConfig(sourceName);
    if (!sourceConfig) {
      return res.status(404).json({ error: 'Template source not found or disabled' });
    }

    const token = await getRegistryToken(sourceConfig, userToken);
    const client = createRegistryClient(sourceConfig, token);

    // If organization is configured, we could list boxes for that org,
    // but /api/discover is the general discovery endpoint for BoxVault
    const response = await client.get('/api/discover');

    return res.json(response.data);
  } catch (error) {
    log.api.error('Error listing remote templates', {
      source: sourceName,
      error: error.message,
      response: error.response?.data,
    });
    return res.status(502).json({
      error: 'Failed to retrieve templates from remote source',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /templates/remote/{sourceName}/{org}/{boxName}:
 *   get:
 *     summary: Get remote template details
 *     description: Retrieves Vagrant-compatible metadata for a specific box
 *     tags: [Template Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sourceName
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: org
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: boxName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Template metadata including versions and providers
 */
export const getRemoteTemplateDetails = async (req, res) => {
  const { sourceName, org, boxName } = req.params;
  const userToken = req.headers['x-registry-token'];

  try {
    const sourceConfig = findSourceConfig(sourceName);
    if (!sourceConfig) {
      return res.status(404).json({ error: 'Template source not found or disabled' });
    }

    const token = await getRegistryToken(sourceConfig, userToken);
    const client = createRegistryClient(sourceConfig, token);
    // Vagrant-compatible metadata endpoint: /{user}/{box}
    const response = await client.get(`/${org}/${boxName}`);

    return res.json(response.data);
  } catch (error) {
    log.api.error('Error getting remote template details', {
      source: sourceName,
      org,
      box: boxName,
      error: error.message,
    });

    if (error.response?.status === 404) {
      return res.status(404).json({ error: 'Template not found on remote source' });
    }

    return res.status(502).json({
      error: 'Failed to retrieve template details',
      details: error.message,
    });
  }
};
