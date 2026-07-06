/**
 * @fileoverview Settings update endpoint
 */

import config from '../../config/ConfigLoader.js';
import { promises as fs } from 'fs';
import yaml from 'js-yaml';
import { log } from '../../lib/Logger.js';
import { createBackup, configPath } from './utils/BackupHelper.js';

/**
 * True for plain objects (not arrays, not null) — the only values we recurse into.
 * @param {*} value
 * @returns {boolean}
 */
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Recursively merge source into target. Nested plain objects merge key-by-key;
 * arrays and scalars replace wholesale. A partial section update therefore keeps
 * its sibling keys instead of dropping them.
 * @param {Object} target - Base object (current config)
 * @param {Object} source - Overrides (incoming settings)
 * @returns {Object} New merged object (inputs not mutated)
 */
const deepMerge = (target, source) => {
  const output = { ...target };
  for (const [key, value] of Object.entries(source)) {
    output[key] =
      isPlainObject(value) && isPlainObject(output[key]) ? deepMerge(output[key], value) : value;
  }
  return output;
};

/**
 * @swagger
 * /settings:
 *   put:
 *     summary: Update application settings
 *     description: >-
 *       Deep-merges the request body into the current configuration: nested objects
 *       merge key-by-key (a partial section update keeps its sibling keys), while
 *       arrays and scalar values replace wholesale. Some changes require a restart.
 *     tags: [Settings]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AppConfig'
 *     responses:
 *       200:
 *         description: Settings updated successfully
 *       500:
 *         description: Failed to update settings
 */
export const updateSettings = async (req, res) => {
  try {
    const newSettings = req.body;

    // 1. Create a backup of the current config file
    await createBackup();

    // 2. Read the current config file
    const currentConfig = yaml.load(await fs.readFile(configPath, 'utf8'));

    // 3. Merge new settings into the current config (deep merge — a partial
    //    section update keeps its sibling keys instead of replacing the section)
    const updatedConfig = deepMerge(currentConfig, newSettings);

    // 4. Validate the new configuration (basic validation for now)
    if (!updatedConfig.server || !updatedConfig.server.http_port) {
      throw new Error('Invalid configuration: server.http_port is required');
    }

    // 5. Write the updated config to a temporary file
    const tempConfigPath = `${configPath}.tmp`;
    await fs.writeFile(tempConfigPath, yaml.dump(updatedConfig), 'utf8');

    // 6. Atomically replace the old config with the new one
    await fs.rename(tempConfigPath, configPath);

    // 7. Reload the configuration in the ConfigLoader
    config.load();

    return res.json({
      success: true,
      message: 'Settings updated successfully. Some changes may require a server restart.',
    });
  } catch (error) {
    log.api.error('Error updating settings', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to update settings', details: error.message });
  }
};
