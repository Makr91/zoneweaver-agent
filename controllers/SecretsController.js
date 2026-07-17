/**
 * @fileoverview Global secrets endpoints (architecture D-C, SHI's SecretsPage categories)
 * @description GET serves the whole document — plain, nothing masked (Mark's
 * ruling: it is the user's local machine, and the generated Hosts.yml carries
 * these as SECRETS_* vars anyway). PUT replaces the submitted categories, the
 * same top-level shallow-merge shape as PUT /settings. Wire copied from the
 * Go agent's shipped /secrets exactly; the `secrets` feature token advertises
 * the surface.
 */

import { getSecrets as readSecrets, replaceSecrets } from '../lib/SecretsStore.js';
import { log } from '../lib/Logger.js';

/**
 * @swagger
 * /secrets:
 *   get:
 *     summary: Get the global secrets document
 *     description: |
 *       The whole secrets document — SHI's six repeatable categories, values
 *       PLAIN (nothing masked; the generated Hosts.yml carries them as
 *       SECRETS_* template vars). Every category is always present as an
 *       array. Persisted to secrets.yaml beside the config file, 0600.
 *     tags: [Secrets]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: The secrets document
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 hcl_download_portal_api_keys:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       key: { type: string }
 *                 git_api_keys:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       key: { type: string }
 *                 vagrant_atlas_token:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       key: { type: string }
 *                 custom_resource_url:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       url: { type: string }
 *                       useAuth: { type: boolean }
 *                       user: { type: string }
 *                       pass: { type: string }
 *                 docker_hub:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       docker_hub_user: { type: string }
 *                       docker_hub_token: { type: string }
 *                 ssh_keys:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       key: { type: string }
 *       500:
 *         description: Failed to read the secrets store
 */
export const getSecrets = (req, res) => {
  void req;
  try {
    return res.json(readSecrets());
  } catch (error) {
    log.api.error('Failed to read secrets store', { error: error.message });
    return res.status(500).json({ error: 'Failed to read secrets', details: error.message });
  }
};

/**
 * @swagger
 * /secrets:
 *   put:
 *     summary: Update the global secrets document
 *     description: |
 *       Replaces the SUBMITTED categories whole (the same top-level
 *       shallow-merge shape as PUT /settings); untouched categories survive.
 *       Unknown categories and invalid entry names (must match
 *       [a-zA-Z0-9_-]+) reject the whole update — the store never
 *       half-applies.
 *     tags: [Secrets]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Map of category name → entries array (only submitted categories change)
 *             example:
 *               git_api_keys:
 *                 - name: github-work
 *                   key: ghp_exampletoken
 *     responses:
 *       200:
 *         description: Secrets updated
 *       400:
 *         description: Invalid body, unknown category, or invalid entry name
 *       500:
 *         description: Failed to persist the secrets store
 */
export const updateSecrets = (req, res) => {
  const categories = req.body;
  if (!categories || typeof categories !== 'object' || Array.isArray(categories)) {
    return res
      .status(400)
      .json({ error: 'Failed to update secrets', details: 'Invalid JSON body' });
  }
  try {
    replaceSecrets(categories);
  } catch (error) {
    // Category/name rejections are the caller's to fix.
    const callerError =
      error.message.startsWith('unknown secrets category') ||
      error.message.startsWith('category ') ||
      error.message.includes('must match');
    log.api.error('Secrets update failed', { error: error.message });
    return res
      .status(callerError ? 400 : 500)
      .json({ error: 'Failed to update secrets', details: error.message });
  }
  log.api.info('Secrets updated', { by: req.entity.name });
  return res.json({ success: true, message: 'Secrets updated successfully' });
};
