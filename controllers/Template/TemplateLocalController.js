/**
 * @fileoverview Template Local Query Controller for Zoneweaver Agent
 * @description Handles listing and retrieval of locally stored templates
 */

import Template from '../../models/TemplateModel.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /templates:
 *   get:
 *     summary: List local templates
 *     description: Lists all templates downloaded and available locally
 *     tags: [Template Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of local templates
 */
export const listLocalTemplates = async (req, res) => {
  void req;
  try {
    const templates = await Template.findAll({
      order: [['created_at', 'DESC']],
    });

    return res.json({
      templates,
      total: templates.length,
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
