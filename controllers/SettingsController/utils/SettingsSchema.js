/**
 * @fileoverview Settings schema definition — aggregating index
 */

import { CORE_SCHEMA } from './schema/CoreSchema.js';
import { ZONES_SCHEMA } from './schema/ZonesSchema.js';
import { PROVISIONING_SCHEMA } from './schema/ProvisioningSchema.js';
import { MONITORING_SCHEMA } from './schema/MonitoringSchema.js';
import { PLATFORM_SCHEMA } from './schema/PlatformSchema.js';
import { STORAGE_SCHEMA } from './schema/StorageSchema.js';

/**
 * Static schema describing all configuration sections, their properties,
 * types, descriptions, defaults, valid ranges, and restart requirements.
 * Section definitions live in ./schema/ modules, one per domain; this index
 * re-aggregates them in the section order the UI renders.
 *
 * Object-typed fields carry a nested `properties` map with the same per-field
 * shape as top level. Every `default` states the effective value when the key
 * is absent from config.yaml (code fallback where one exists, shipped
 * production-config.yaml value otherwise) — buildSchemaDefaults() turns this
 * tree into the defaults layer GET /settings merges the config file over.
 */
export const SETTINGS_SCHEMA = {
  ...CORE_SCHEMA,
  ...ZONES_SCHEMA,
  ...PROVISIONING_SCHEMA,
  ...MONITORING_SCHEMA,
  ...PLATFORM_SCHEMA,
  ...STORAGE_SCHEMA,
};

/**
 * Collect the `default` values of a schema properties map into a plain object,
 * recursing into nested object fields.
 * @param {Object} properties - Schema properties map
 * @returns {Object} Defaults object
 */
const sectionDefaults = properties => {
  const defaults = {};
  for (const [key, field] of Object.entries(properties)) {
    if (field.properties) {
      defaults[key] = sectionDefaults(field.properties);
    } else if ('default' in field) {
      defaults[key] = field.default;
    }
  }
  return defaults;
};

/**
 * Build the complete defaults tree from SETTINGS_SCHEMA — the effective value
 * of every setting when its key is absent from config.yaml. GET /settings
 * merges the config file over this so the served config is always complete.
 * @returns {Object} Defaults object keyed by section
 */
export const buildSchemaDefaults = () => {
  const defaults = {};
  for (const [section, definition] of Object.entries(SETTINGS_SCHEMA)) {
    defaults[section] = sectionDefaults(definition.properties || {});
  }
  return defaults;
};
