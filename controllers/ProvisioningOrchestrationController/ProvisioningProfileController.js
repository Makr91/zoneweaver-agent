/**
 * @fileoverview Provisioning profile CRUD endpoints
 */

import ProvisioningProfiles from '../../models/ProvisioningProfileModel.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /provisioning/profiles:
 *   get:
 *     summary: List all provisioning profiles
 *     description: Returns all saved provisioning profiles.
 *     tags: [Provisioning Profiles]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of profiles
 *       500:
 *         description: Failed to list profiles
 */
export const listProvisioningProfiles = async (req, res) => {
  void req;
  try {
    const profiles = await ProvisioningProfiles.findAll({
      order: [['name', 'ASC']],
    });

    return res.json({
      success: true,
      count: profiles.length,
      profiles,
    });
  } catch (error) {
    log.api.error('Failed to list provisioning profiles', { error: error.message });
    return res.status(500).json({
      error: 'Failed to list provisioning profiles',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /provisioning/profiles:
 *   post:
 *     summary: Create a provisioning profile
 *     description: Creates a reusable provisioning profile combining recipe, credentials, and provisioners.
 *     tags: [Provisioning Profiles]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               recipe_id:
 *                 type: string
 *               default_credentials:
 *                 type: object
 *               default_sync_folders:
 *                 type: array
 *               default_provisioners:
 *                 type: array
 *               default_variables:
 *                 type: object
 *     responses:
 *       201:
 *         description: Profile created
 *       400:
 *         description: Invalid profile data
 *       409:
 *         description: Profile already exists
 *       500:
 *         description: Failed to create profile
 */
export const createProvisioningProfile = async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const existing = await ProvisioningProfiles.findOne({ where: { name } });
    if (existing) {
      return res.status(409).json({ error: `Profile '${name}' already exists` });
    }

    const profile = await ProvisioningProfiles.create({
      name,
      description: req.body.description,
      recipe_id: req.body.recipe_id,
      default_credentials: req.body.default_credentials,
      default_sync_folders: req.body.default_sync_folders,
      default_provisioners: req.body.default_provisioners,
      default_variables: req.body.default_variables || {},
      created_by: req.entity.name,
    });

    log.api.info('Provisioning profile created', { id: profile.id, name });
    return res.status(201).json({ success: true, profile });
  } catch (error) {
    log.api.error('Failed to create provisioning profile', { error: error.message });
    return res.status(500).json({
      error: 'Failed to create provisioning profile',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /provisioning/profiles/{id}:
 *   get:
 *     summary: Get profile details
 *     description: Returns a single provisioning profile by ID.
 *     tags: [Provisioning Profiles]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Profile details
 *       404:
 *         description: Profile not found
 *       500:
 *         description: Failed to get profile
 */
export const getProvisioningProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const profile = await ProvisioningProfiles.findByPk(id);

    if (!profile) {
      return res.status(404).json({ error: `Profile '${id}' not found` });
    }

    return res.json({ success: true, profile });
  } catch (error) {
    log.api.error('Failed to get provisioning profile', { error: error.message });
    return res.status(500).json({
      error: 'Failed to get provisioning profile',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /provisioning/profiles/{id}:
 *   put:
 *     summary: Update a provisioning profile
 *     description: Updates an existing profile.
 *     tags: [Provisioning Profiles]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Profile updated
 *       404:
 *         description: Profile not found
 *       500:
 *         description: Failed to update profile
 */
export const updateProvisioningProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const profile = await ProvisioningProfiles.findByPk(id);

    if (!profile) {
      return res.status(404).json({ error: `Profile '${id}' not found` });
    }

    const allowedFields = [
      'name',
      'description',
      'recipe_id',
      'default_credentials',
      'default_sync_folders',
      'default_provisioners',
      'default_variables',
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }
    updates.updated_at = new Date();

    await profile.update(updates);

    log.api.info('Provisioning profile updated', { id, name: profile.name });
    return res.json({ success: true, profile });
  } catch (error) {
    log.api.error('Failed to update provisioning profile', { error: error.message });
    return res.status(500).json({
      error: 'Failed to update provisioning profile',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /provisioning/profiles/{id}:
 *   delete:
 *     summary: Delete a provisioning profile
 *     description: Permanently removes a profile.
 *     tags: [Provisioning Profiles]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Profile deleted
 *       404:
 *         description: Profile not found
 *       500:
 *         description: Failed to delete profile
 */
export const deleteProvisioningProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const profile = await ProvisioningProfiles.findByPk(id);

    if (!profile) {
      return res.status(404).json({ error: `Profile '${id}' not found` });
    }

    const { name } = profile;
    await profile.destroy();

    log.api.info('Provisioning profile deleted', { id, name });
    return res.json({ success: true, message: `Profile '${name}' deleted` });
  } catch (error) {
    log.api.error('Failed to delete provisioning profile', { error: error.message });
    return res.status(500).json({
      error: 'Failed to delete provisioning profile',
      details: error.message,
    });
  }
};
