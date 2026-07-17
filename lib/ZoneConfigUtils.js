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
 * Every zvol dataset a zone's LIVE config references: bootdisk/diskN — BOTH
 * zadm spellings (top-level string OR object with .path, plus raw attr rows)
 * — and zvol device matches. THE one disk-reference reader (the divergent
 * snapshot/delete parsers converge here in the disk-spec batch).
 * @param {Object} zoneConfig - zadm-sourced zone configuration
 * @returns {Set<string>} Referenced zvol dataset names
 */
export const collectZoneDiskDatasets = zoneConfig => {
  const datasets = new Set();
  const addDisk = value => {
    if (typeof value === 'string' && value) {
      datasets.add(value);
    } else if (value && typeof value === 'object' && typeof value.path === 'string' && value.path) {
      datasets.add(value.path);
    }
  };
  for (const [key, value] of Object.entries(zoneConfig || {})) {
    if (key === 'bootdisk' || /^disk\d+$/u.test(key)) {
      addDisk(value);
    }
  }
  const attrs = Array.isArray(zoneConfig?.attr) ? zoneConfig.attr : [];
  for (const attr of attrs) {
    if (attr?.name && /^(?:bootdisk|disk\d+)$/u.test(attr.name)) {
      addDisk(attr.value);
    }
  }
  const devices = Array.isArray(zoneConfig?.device) ? zoneConfig.device : [];
  for (const device of devices) {
    const match =
      typeof device?.match === 'string' &&
      device.match.match(/\/dev\/zvol\/r?dsk\/(?<dataset>.+)$/u);
    if (match?.groups?.dataset) {
      datasets.add(match.groups.dataset);
    }
  }
  return datasets;
};

/**
 * Map every zvol dataset referenced by ANY zone to its zone name — the
 * attachability feed (volume rows' in_use_by on GET /storage/datasets).
 * @returns {Promise<Map<string, string>>} dataset → zone name
 */
export const mapZvolDatasetsToZones = async () => {
  const map = new Map();
  const allConfigs = await getAllZoneConfigs();
  for (const [zoneName, zoneConfig] of Object.entries(allConfigs)) {
    for (const dataset of collectZoneDiskDatasets(zoneConfig)) {
      if (!map.has(dataset)) {
        map.set(dataset, zoneName);
      }
    }
  }
  return map;
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

/**
 * Parse a zone record's stored configuration (JSON column or serialized
 * string) into an object — THE one parse everybody uses; unparseable
 * configurations read as {}.
 * @param {Object} zone - Zone database record
 * @returns {Object} Parsed configuration
 */
export const parseConfiguration = zone => {
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

/**
 * The zone's provisioning dataset mountpoint derived from its zonepath
 * (`<zonepath minus /path>/provisioning`) — the ONE derivation.
 * @param {string} zonepath - The zone's zonepath
 * @returns {string|null} Provisioning dataset path (null without a zonepath)
 */
export const provisioningPathFromZonepath = zonepath =>
  typeof zonepath === 'string' && zonepath ? `${zonepath.replace('/path', '')}/provisioning` : null;

/**
 * Build the bhyve vcpus attr value — THE builder for create (zones.* spelling)
 * and modify (top-level spelling) alike; callers hand in their own fields.
 * Format: [[cpus=]numcpus][,sockets=n][,cores=n][,threads=n]
 * @param {string|undefined} cpuConfiguration - 'simple' | 'complex' (absent = simple)
 * @param {Array|undefined} complexCpuConf - [{sockets, cores, threads}] for complex mode
 * @param {string|number|undefined} vcpus - Plain vCPU count for simple mode
 * @returns {string|number|undefined} vcpus attr value (undefined when nothing requested)
 * @throws {Error} On invalid topology or cpu_configuration
 */
export const buildCpuValue = (cpuConfiguration, complexCpuConf, vcpus) => {
  if (!cpuConfiguration || cpuConfiguration === 'simple') {
    if (vcpus === undefined || vcpus === null || vcpus === '') {
      return vcpus;
    }
    // Canonical integer at apply (cross-agent rule, Go's string-float flag):
    // a guard-passed "4.0" writes 4 into zonecfg, never the raw spelling.
    // Non-whole values pass through verbatim — the API pre-flight already
    // refused them; old task metadata keeps its exact behavior.
    const count = Number(vcpus);
    return Number.isInteger(count) ? count : vcpus;
  }

  if (cpuConfiguration === 'complex') {
    if (!complexCpuConf || complexCpuConf.length === 0) {
      throw new Error('complex_cpu_conf required when cpu_configuration is "complex"');
    }

    const [conf] = complexCpuConf;
    const { sockets, cores, threads } = conf;

    if (!sockets || !cores || !threads) {
      throw new Error('complex_cpu_conf must specify sockets, cores, and threads');
    }

    if (sockets < 1 || cores < 1 || threads < 1) {
      throw new Error('sockets, cores, and threads must be >= 1');
    }

    if (sockets > 16) {
      throw new Error('sockets must be <= 16 (bhyve limit)');
    }

    if (cores > 32) {
      throw new Error('cores must be <= 32 (bhyve limit)');
    }

    if (threads > 2) {
      throw new Error('threads must be <= 2 (SMT limit)');
    }

    const total = sockets * cores * threads;
    if (total > 32) {
      throw new Error(`Total vCPUs (${total}) exceeds bhyve maximum of 32`);
    }

    return `sockets=${sockets},cores=${cores},threads=${threads}`;
  }

  throw new Error(`Invalid cpu_configuration: ${cpuConfiguration}. Must be "simple" or "complex"`);
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
 * Record a resized disk's new size in the machine document.
 *
 * `disks` is a DOCUMENT section, so it OVERLAYS zadm's live view on the detail
 * GET — a resize that only touches the zvol leaves the document (and therefore
 * the API) reporting the create-time size forever, while zadm's untouched
 * `bootdisk.size` next to it reports the real one. Two sizes, one lying. This
 * keeps the document honest.
 *
 * The boot disk is `disks.boot`; an additional disk is matched by its volume
 * name, which is the zvol's leaf (the disk ATTR name — disk0, disk1 — is a
 * different namespace and does not index the document).
 * @param {string} zoneName - Zone name
 * @param {string} diskName - Disk attr name (bootdisk, disk0, …)
 * @param {string} dataset - The zvol dataset that was resized
 * @param {string} size - The new size, as written to volsize
 * @returns {Promise<boolean>} True when a document entry was updated
 */
export const setDocumentDiskSize = (zoneName, diskName, dataset, size) =>
  saveConfiguration(zoneName, zoneConfig => {
    const { disks } = zoneConfig;
    if (!disks) {
      return false;
    }
    if (diskName === 'bootdisk') {
      if (!disks.boot) {
        return false;
      }
      disks.boot.size = size;
      return true;
    }
    const volumeName = dataset.split('/').pop();
    const entry = Array.isArray(disks.additional)
      ? disks.additional.find(disk => disk?.volume_name === volumeName)
      : null;
    if (!entry) {
      return false;
    }
    entry.size = size;
    return true;
  });

/**
 * Append disks the modify path CREATED/ATTACHED to the machine document's
 * typed disks block — document honesty (the resize pattern generalized):
 * every agent-driven disk mutation writes the document too, so GET never
 * answers a disk count the zone doesn't have. ONE save for the whole batch.
 * @param {string} zoneName - Zone name
 * @param {Array<Object>} entries - Typed additional_disks entries
 * @returns {Promise<number|null>} New list length (null when zone unknown)
 */
export const appendDocumentDisks = (zoneName, entries) =>
  saveConfiguration(zoneName, zoneConfig => {
    zoneConfig.disks = zoneConfig.disks || {};
    const list = Array.isArray(zoneConfig.disks.additional_disks)
      ? zoneConfig.disks.additional_disks
      : [];
    list.push(...entries);
    zoneConfig.disks.additional_disks = list;
    return list.length;
  });

/**
 * Drop removed disks from the document's typed disks block, matched by the
 * zvol dataset (image path, or a created dataset's volume_name leaf).
 * @param {string} zoneName - Zone name
 * @param {Array<string>} datasets - Removed zvol dataset paths
 * @returns {Promise<number|null>} How many entries were dropped
 */
export const removeDocumentDisks = (zoneName, datasets) =>
  saveConfiguration(zoneName, zoneConfig => {
    const list = zoneConfig.disks?.additional_disks;
    if (!Array.isArray(list)) {
      return 0;
    }
    let removed = 0;
    for (const dataset of datasets) {
      const leaf = String(dataset).split('/').pop();
      const index = list.findIndex(entry => entry?.path === dataset || entry?.volume_name === leaf);
      if (index !== -1) {
        list.splice(index, 1);
        removed++;
      }
    }
    return removed;
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
