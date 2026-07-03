/**
 * @fileoverview Zone Configuration Utilities
 * @description Shared utilities for fetching and parsing zone configurations from zadm
 * CRITICAL: NO BACKWARD COMPATIBILITY - Hosts.yml structure ONLY (settings/zones/networks/disks/provisioner)
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { executeCommand } from './CommandManager.js';
import yj from 'yieldable-json';
import { log } from './Logger.js';
import Zones from '../models/ZoneModel.js';
import os from 'os';

/**
 * Get zone configuration from zadm show
 * @description Fetches zone configuration using zadm show and parses the JSON output
 * @param {string} zoneName - Name of the zone
 * @param {Object} options - Configuration options
 * @param {boolean} options.useBlocking - Use blocking JSON.parse instead of non-blocking yj.parseAsync (default: false)
 * @returns {Promise<Object>} Parsed zone configuration object
 * @throws {Error} If command fails or JSON parsing fails
 */
export const getZoneConfig = async (zoneName, options = {}) => {
  const { useBlocking = false } = options;

  log.monitoring.debug('Fetching zone configuration', {
    zone_name: zoneName,
    use_blocking: useBlocking,
  });

  const result = await executeCommand(`pfexec zadm show ${zoneName}`);
  if (!result.success) {
    throw new Error(`Failed to get zone configuration: ${result.error}`);
  }

  // Use non-blocking parse by default (better for large configs)
  if (useBlocking) {
    try {
      return JSON.parse(result.output);
    } catch (error) {
      throw new Error(`Failed to parse zone configuration: ${error.message}`);
    }
  }

  // Non-blocking async parse for large JSON configs
  return new Promise((resolve, reject) => {
    yj.parseAsync(result.output, (err, parsed) => {
      if (err) {
        reject(new Error(`Failed to parse zone configuration: ${err.message}`));
      } else {
        resolve(parsed);
      }
    });
  });
};

/**
 * Get all zone configurations from zadm show
 * @description Fetches all zone configurations at once using zadm show (no zone name)
 * @returns {Promise<Object>} Object mapping zone names to their configurations
 * @throws {Error} If command fails or JSON parsing fails
 */
export const getAllZoneConfigs = async () => {
  log.monitoring.debug('Fetching all zone configurations');

  const result = await executeCommand('pfexec zadm show');
  if (!result.success) {
    throw new Error(`Failed to get all zone configurations: ${result.error}`);
  }

  // Always use non-blocking parse for all zones (large JSON)
  return new Promise((resolve, reject) => {
    yj.parseAsync(result.output, (err, parsed) => {
      if (err) {
        reject(new Error(`Failed to parse zone configurations: ${err.message}`));
      } else {
        resolve(parsed);
      }
    });
  });
};

/**
 * Parse and preserve user-defined configuration sections
 * @param {Object} existing - Existing zone record
 * @param {Object} zoneConfig - Zone config from zadm
 * @param {string} zoneName - Zone name
 */
export const preserveUserConfig = (existing, zoneConfig, zoneName) => {
  if (!existing || !existing.configuration) {
    return;
  }

  let existingConfig = existing.configuration;
  if (typeof existingConfig === 'string') {
    try {
      existingConfig = JSON.parse(existingConfig);
    } catch (e) {
      log.monitoring.warn('Failed to parse existing zone configuration', {
        zone_name: zoneName,
        error: e.message,
      });
      return;
    }
  }

  // Preserve Hosts.yml infrastructure sections (NEW structure ONLY)
  if (existingConfig.settings && !zoneConfig.settings) {
    zoneConfig.settings = existingConfig.settings;
  }
  if (existingConfig.zones && !zoneConfig.zones) {
    zoneConfig.zones = existingConfig.zones;
  }
  if (existingConfig.networks && !zoneConfig.networks) {
    zoneConfig.networks = existingConfig.networks;
  }
  if (existingConfig.disks && !zoneConfig.disks) {
    zoneConfig.disks = existingConfig.disks;
  }
  if (existingConfig.provisioner && !zoneConfig.provisioner) {
    zoneConfig.provisioner = existingConfig.provisioner;
  }
};

/**
 * Sync zone configuration to database (Upsert)
 * @description Fetches zone config from system and creates/updates the database record immediately
 * @param {string} zoneName - Name of the zone
 * @param {string} [statusOverride] - Optional status to force (e.g. 'installed')
 * @param {Object} [providedConfig] - Optional zone configuration object if already fetched
 * @returns {Promise<Object>} The updated/created zone record
 */
export const syncZoneToDatabase = async (
  zoneName,
  statusOverride = null,
  providedConfig = null
) => {
  try {
    log.monitoring.debug('Syncing zone to database', { zone_name: zoneName });

    const zoneConfig = providedConfig || (await getZoneConfig(zoneName));

    let status = statusOverride;
    if (!status) {
      const result = await executeCommand(`pfexec zoneadm -z ${zoneName} list -p`);
      if (result.success) {
        const parts = result.output.split(':');
        status = parts[2] || 'configured';
      } else {
        status = 'configured';
      }
    }

    const zoneData = {
      name: zoneName,
      zone_id: zoneConfig.uuid || zoneName,
      host: os.hostname(),
      status,
      brand: zoneConfig.brand || 'unknown',
      last_seen: new Date(),
      configuration: zoneConfig,
    };

    const existing = await Zones.findOne({ where: { name: zoneName } });

    preserveUserConfig(existing, zoneConfig, zoneName);

    if (existing) {
      if (existing.server_id) {
        zoneData.server_id = existing.server_id;
      }
      if (existing.vm_type) {
        zoneData.vm_type = existing.vm_type;
      }
      return await existing.update(zoneData);
    }
    return await Zones.create({ ...zoneData, auto_discovered: false });
  } catch (error) {
    log.monitoring.error('Failed to sync zone to database', {
      zone_name: zoneName,
      error: error.message,
    });
    throw error;
  }
};
