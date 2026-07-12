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
import { hasSuspendCheckpoint } from './SuspendCheckpoint.js';
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
 * Read one zonecfg attr straight from the zone's stored config — presence +
 * raw value exactly as written. zadm's JSON rendering of attrs varies by
 * shape, so anything deciding add-vs-select or prefilling a PUT value reads
 * here, never the zadm view.
 * @param {string} zoneName - Zone name
 * @param {string} attrName - attr resource name (e.g. extra, vnc)
 * @returns {Promise<{exists: boolean, value: string}>} Attr presence + raw value
 */
export const readZonecfgAttr = async (zoneName, attrName) => {
  const result = await executeCommand(`pfexec zonecfg -z ${zoneName} info attr name=${attrName}`);
  const lines = (result.success ? result.output || '' : '').split('\n').map(line => line.trim());
  if (!lines.includes(`name: ${attrName}`)) {
    return { exists: false, value: '' };
  }
  const valueLine = lines.find(line => line.startsWith('value: '));
  let value = valueLine ? valueLine.slice('value: '.length).trim() : '';
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return { exists: true, value };
};

/**
 * Hosts.yml document sections owned by the database document store — the
 * agent's PUT/GET machine-document contract. zadm never authors these; when a
 * stale copy rides in zonecfg output, the database still wins.
 */
const DOCUMENT_SECTIONS = [
  'settings',
  'zones',
  'networks',
  'disks',
  'provisioner',
  'provisioner_ref',
  'provisioner_state',
  'pending_changes',
  'guest_info',
  'snapshots',
  'metadata',
];

const parseConfiguration = zone => {
  let zoneConfig = zone?.configuration || {};
  if (typeof zoneConfig === 'string') {
    try {
      zoneConfig = JSON.parse(zoneConfig);
    } catch {
      zoneConfig = {};
    }
  }
  return zoneConfig;
};

const saveConfiguration = async (zoneName, mutate) => {
  const zone = await Zones.findOne({ where: { name: zoneName } });
  if (!zone) {
    return null;
  }
  // The JSON column hands back the row's live object — mutating it in place
  // makes Sequelize's change detection compare the object to itself and SKIP
  // the write (the credentials/pending_changes/guest_info round-trip bug).
  // Mutate a detached clone and mark the column changed explicitly.
  const zoneConfig = structuredClone(parseConfiguration(zone));
  const result = mutate(zoneConfig);
  zone.set('configuration', zoneConfig);
  zone.changed('configuration', true);
  await zone.save();
  return result;
};

/**
 * Record (or clear, with null) a zone's guest-agent observation at
 * configuration.guest_info — fresh-read + merge, never clobbering the document.
 */
export const setGuestInfo = (zoneName, info) =>
  saveConfiguration(zoneName, zoneConfig => {
    if (info === null) {
      delete zoneConfig.guest_info;
    } else {
      zoneConfig.guest_info = info;
    }
    return zoneConfig.guest_info || null;
  });

/**
 * Merge an accrued modify body into configuration.pending_changes (per
 * top-level key the last edit wins) and return the merged set.
 */
export const mergePendingChanges = (zoneName, updates) =>
  saveConfiguration(zoneName, zoneConfig => {
    const pending = { ...(zoneConfig.pending_changes || {}) };
    for (const [key, value] of Object.entries(updates)) {
      pending[key] = value;
    }
    zoneConfig.pending_changes = pending;
    return pending;
  });

/**
 * Drop the accrued pending set (cancel path + the executor's apply-success
 * cleanup). Returns the cleared keys.
 */
export const clearPendingChanges = zoneName =>
  saveConfiguration(zoneName, zoneConfig => {
    const keys = Object.keys(zoneConfig.pending_changes || {}).sort();
    delete zoneConfig.pending_changes;
    return keys;
  });

/**
 * Store (or clear, with null) the zone's snapshot retention policy override
 * at configuration.snapshots — the rotation service reads it over the
 * agent-level default.
 */
export const setSnapshotPolicy = (zoneName, policy) =>
  saveConfiguration(zoneName, zoneConfig => {
    if (policy === null) {
      delete zoneConfig.snapshots;
    } else {
      zoneConfig.snapshots = policy;
    }
    return zoneConfig.snapshots || null;
  });

/**
 * Merge individual keys INTO configuration.settings (the DB-immediate
 * credentials family). A null or empty-string value deletes the key.
 */
export const mergeSettingsKeys = (zoneName, keys) =>
  saveConfiguration(zoneName, zoneConfig => {
    const settings = { ...(zoneConfig.settings || {}) };
    for (const [key, value] of Object.entries(keys)) {
      if (value === null || value === '') {
        delete settings[key];
      } else {
        settings[key] = value;
      }
    }
    zoneConfig.settings = settings;
    return settings;
  });

/**
 * Overlay the database-owned document sections onto a zadm-sourced config.
 * The document store (zone.configuration in the DB) is authoritative for the
 * Hosts.yml sections — zadm output never adds to or replaces them.
 * @param {Object|string|null} dbConfiguration - zone.configuration from the DB record
 * @param {Object} zoneConfig - zadm-sourced config object (mutated in place)
 * @param {string} zoneName - Zone name (for logging)
 * @returns {Object} The overlaid zoneConfig
 */
export const overlayDocumentSections = (dbConfiguration, zoneConfig, zoneName) => {
  let dbConfig = dbConfiguration;
  if (typeof dbConfig === 'string') {
    try {
      dbConfig = JSON.parse(dbConfig);
    } catch (e) {
      log.monitoring.warn('Failed to parse stored zone configuration', {
        zone_name: zoneName,
        error: e.message,
      });
      return zoneConfig;
    }
  }
  if (!dbConfig || typeof dbConfig !== 'object') {
    return zoneConfig;
  }
  for (const section of DOCUMENT_SECTIONS) {
    if (dbConfig[section] !== undefined) {
      zoneConfig[section] = dbConfig[section];
    }
  }
  return zoneConfig;
};

/**
 * Preserve the document-store sections when refreshing a zone record from zadm.
 * The DB sections ALWAYS win — a provisioner/settings copy in zadm output can
 * never overwrite the document a PUT stored (and provisioner_state survives
 * discovery ticks, keeping the run-directive history intact).
 * @param {Object} existing - Existing zone record
 * @param {Object} zoneConfig - Zone config from zadm (mutated in place)
 * @param {string} zoneName - Zone name
 */
export const preserveUserConfig = (existing, zoneConfig, zoneName) => {
  if (!existing || !existing.configuration) {
    return;
  }
  overlayDocumentSections(existing.configuration, zoneConfig, zoneName);
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

    // A suspended zone looks merely installed to zoneadm — the checkpoint
    // file is the truth. Suspended survives the refresh while it exists;
    // running (or an explicit override) always wins.
    if (
      !statusOverride &&
      zoneData.status !== 'running' &&
      existing?.status === 'suspended' &&
      (await hasSuspendCheckpoint(zoneConfig.zonepath))
    ) {
      zoneData.status = 'suspended';
    }

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
