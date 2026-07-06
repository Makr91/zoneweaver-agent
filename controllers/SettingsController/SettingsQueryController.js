/**
 * @fileoverview Settings query endpoints
 */

import config from '../../config/ConfigLoader.js';
import yj from 'yieldable-json';
import { log } from '../../lib/Logger.js';
import { SETTINGS_SCHEMA, buildSchemaDefaults } from './utils/SettingsSchema.js';

/**
 * Deep-merge the config-file values over the schema defaults. File values win;
 * arrays and scalars are taken wholesale from the file when present.
 * @param {any} base - Defaults value
 * @param {any} override - Config-file value
 * @returns {any} Effective value
 */
const deepMerge = (base, override) => {
  if (override === undefined) {
    return base;
  }
  if (
    base === null ||
    typeof base !== 'object' ||
    Array.isArray(base) ||
    override === null ||
    typeof override !== 'object' ||
    Array.isArray(override)
  ) {
    return override;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in merged ? deepMerge(merged[key], value) : value;
  }
  return merged;
};

/**
 * @swagger
 * tags:
 *   name: Settings
 *   description: Manage application configuration
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     AppConfig:
 *       type: object
 *       properties:
 *         server:
 *           type: object
 *           properties:
 *             http_port:
 *               type: integer
 *             https_port:
 *               type: integer
 *         ssl:
 *           type: object
 *           properties:
 *             key_path:
 *               type: string
 *             cert_path:
 *               type: string
 *         cors:
 *           type: object
 *           properties:
 *             whitelist:
 *               type: array
 *               items:
 *                 type: string
 *         database:
 *           type: object
 *           properties:
 *             dialect:
 *               type: string
 *             storage:
 *               type: string
 *             logging:
 *               type: boolean
 *         api_keys:
 *           type: object
 *           properties:
 *             bootstrap_enabled:
 *               type: boolean
 *             bootstrap_auto_disable:
 *               type: boolean
 *             key_length:
 *               type: integer
 *             hash_rounds:
 *               type: integer
 *         stats:
 *           type: object
 *           properties:
 *             public_access:
 *               type: boolean
 *         zones:
 *           type: object
 *         vnc:
 *           type: object
 *         host_monitoring:
 *           type: object
 *         template_sources:
 *           type: object
 *           properties:
 *             enabled:
 *               type: boolean
 *             local_storage_path:
 *               type: string
 *             sources:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                   url:
 *                     type: string
 */

/**
 * @swagger
 * /settings:
 *   get:
 *     summary: Get current application settings
 *     description: |
 *       Returns the complete effective configuration — every setting the agent honors,
 *       with schema defaults filled in for keys absent from config.yaml (config-file
 *       values always win).
 *     tags: [Settings]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Current effective application configuration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AppConfig'
 *       500:
 *         description: Failed to get settings
 */
export const getSettings = async (req, res) => {
  void req;
  try {
    // Return a sanitized version of the config, omitting sensitive details
    const fileConfig = config.getAll();

    if (!fileConfig) {
      return res
        .status(500)
        .json({ error: 'Failed to get settings', details: 'Configuration not loaded' });
    }

    // Effective config: schema defaults filled in for keys the file omits
    const currentConfig = deepMerge(buildSchemaDefaults(), fileConfig);

    const sanitizedConfig = await new Promise((resolve, reject) => {
      yj.stringifyAsync(currentConfig, (err, jsonString) => {
        if (err) {
          reject(err);
        } else {
          yj.parseAsync(jsonString, (parseErr, result) => {
            if (parseErr) {
              reject(parseErr);
            } else {
              resolve(result);
            }
          });
        }
      });
    });

    // Remove sensitive fields that should not be exposed to the frontend
    if (sanitizedConfig.database) {
      delete sanitizedConfig.database.password;
    }
    if (sanitizedConfig.api_keys) {
      // We might want to show some API key settings, but not all
    }

    return res.json(sanitizedConfig);
  } catch (error) {
    log.api.error('Error getting settings', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to get settings', details: error.message });
  }
};

/**
 * @swagger
 * /settings/schema:
 *   get:
 *     summary: Get settings schema
 *     description: |
 *       Returns the settings field metadata (AGREED schema contract, Go-agent
 *       parity): a map of top-level SECTION name to
 *       `{description, requires_restart, properties}`. Field descriptors inside
 *       `properties` carry type, description, default, and optional min/max/enum;
 *       object-typed fields nest `properties` recursively (same shape). Covers
 *       every honored configuration key.
 *     tags: [Settings]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Settings schema retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties:
 *                 type: object
 *                 properties:
 *                   type:
 *                     type: string
 *                   description:
 *                     type: string
 *                   requires_restart:
 *                     type: boolean
 *                   properties:
 *                     type: object
 */
export const getSettingsSchema = (req, res) => {
  void req;
  return res.json(SETTINGS_SCHEMA);
};
