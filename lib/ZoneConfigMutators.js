/**
 * @fileoverview Zone document mutators
 * @description The saveConfiguration-based writers that record agent-driven changes back
 * into a machine's stored document (pending changes, snapshot policy, disk/network document
 * entries, settings keys, guest info). Split from ZoneConfigUtils; consumes the document store.
 */

import { saveConfiguration } from './ZoneConfigDocumentStore.js';

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
    const entry = Array.isArray(disks.additional_disks)
      ? disks.additional_disks.find(disk => disk?.volume_name === volumeName)
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
 * Record ONE key on a network entry in the machine document (document
 * honesty — the disk-resize pattern). The entry is addressed by its
 * networks[] INDEX (the declared pairing rule with the zone's net
 * resources).
 * @param {string} zoneName - Zone name
 * @param {number} index - networks[] index
 * @param {string} key - Entry key to set
 * @param {*} value - Value to record
 * @returns {Promise<boolean|null>} True when recorded (null when zone unknown)
 */
export const setDocumentNetworkKey = (zoneName, index, key, value) =>
  saveConfiguration(zoneName, zoneConfig => {
    const entry = Array.isArray(zoneConfig.networks) ? zoneConfig.networks[index] : null;
    if (!entry) {
      return false;
    }
    entry[key] = value;
    return true;
  });

/**
 * The provisioning-lease writeback: record the leased address on the entry.
 * @param {string} zoneName - Zone name
 * @param {number} index - networks[] index
 * @param {string} address - The address to record
 * @returns {Promise<boolean|null>} True when recorded (null when zone unknown)
 */
export const setDocumentNetworkAddress = (zoneName, index, address) =>
  setDocumentNetworkKey(zoneName, index, 'address', address);

/**
 * Remove a network entry from the machine document (the transport-removal
 * half of Mark's execution ruling) and flip `is_control` to the machine's
 * first remaining entry when no control entry survives.
 * @param {string} zoneName - Zone name
 * @param {number} index - networks[] index to remove
 * @returns {Promise<boolean|null>} True when removed (null when zone unknown)
 */
export const removeDocumentNetworkEntry = (zoneName, index) =>
  saveConfiguration(zoneName, zoneConfig => {
    const list = Array.isArray(zoneConfig.networks) ? zoneConfig.networks : null;
    if (!list || !list[index]) {
      return false;
    }
    list.splice(index, 1);
    if (list.length > 0 && !list.some(net => net?.is_control === true)) {
      list[0].is_control = true;
    }
    return true;
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
