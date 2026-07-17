/**
 * @fileoverview The typed disk wire — cross-agent DISK SPEC (frozen 2026-07-17)
 * @description ZERO inference (Mark's ruling): every disk entry DECLARES its
 * type; agents only validate the declaration. Refusal strings are FROZEN
 * VERBATIM across both agents (Go authored, zoneweaver adopted). Created
 * disks are stamped on the resource itself (`zoneweaver:source`) so ownership
 * is recorded, never re-derived — deletion destroys stamped datasets only.
 * Other-hypervisor keys warn via resource_warnings[]; unknown keys ride the
 * document verbatim (in-guest role data).
 */

import { executeCommand } from './CommandManager.js';
import { mapZvolDatasetsToZones } from './ZoneConfigUtils.js';

export const BOOT_DISK_TYPES = ['template', 'image', 'blank', 'none'];
export const ADDITIONAL_DISK_TYPES = ['image', 'blank'];

/** The ownership stamp (ZFS user property). Values: blank | template | zone
 * (zone = the zone-root dataset, zoneweaver-internal). Absent = FOREIGN —
 * deletion never touches it. */
export const SOURCE_PROPERTY = 'zoneweaver:source';

/** VBox placement vocabulary — valid on the wire, unused on bhyve (warned). */
const VBOX_ONLY_ENTRY_KEYS = ['controller', 'port', 'device'];

/**
 * Apply the spec's documented default for an absent boot entry: template when
 * settings.box is present, else none (diskless). DECLARED into the body so
 * the stored document carries the resolved type.
 * @param {Object} body - Create request body (mutated)
 * @returns {Object} body.disks
 */
export const normalizeDisks = body => {
  body.disks = body.disks || {};
  if (!body.disks.boot) {
    body.disks.boot = { type: body.settings?.box ? 'template' : 'none' };
  }
  return body.disks;
};

const warn = (warnings, message) => warnings.push({ resource: 'disks', message });

const vboxKeyWarnings = (where, entry, warnings) => {
  const present = VBOX_ONLY_ENTRY_KEYS.filter(key => entry[key] !== undefined);
  if (present.length > 0) {
    warn(warnings, `${where}: ${present.join(', ')} are not used on this hypervisor`);
  }
};

const validateBootEntry = (boot, settings, errors, warnings) => {
  if (!boot.type) {
    errors.push(
      'disks.boot.type is required when disks.boot is present (template|image|blank|none)'
    );
    return;
  }
  if (!BOOT_DISK_TYPES.includes(boot.type)) {
    errors.push(
      `disks.boot.type ${boot.type} is not a valid disk type (template|image|blank|none)`
    );
    return;
  }
  if (boot.type === 'template' && !settings?.box) {
    errors.push('disks.boot.type template requires settings.box');
  }
  if (boot.type === 'blank' && !boot.size) {
    errors.push('disks.boot.type blank requires size');
  }
  if (boot.type === 'image' && !boot.path) {
    errors.push('disks.boot.type image requires path');
  }
  if (boot.type === 'image' && (boot.size !== undefined || boot.volume_name !== undefined)) {
    errors.push(
      'disks.boot.type image does not take size or volume_name (an image attaches as-is)'
    );
  }
  if (boot.type === 'blank' && boot.path !== undefined) {
    errors.push('disks.boot.type blank does not take path');
  }
  if (boot.type === 'template' && boot.path !== undefined) {
    errors.push('disks.boot.type template does not take path');
  }
  if (boot.type === 'none' && Object.keys(boot).some(key => key !== 'type')) {
    errors.push('disks.boot.type none takes no other keys');
  }
  if (settings?.box && boot.type !== 'template') {
    warn(
      warnings,
      `settings.box is set but disks.boot.type is ${boot.type} — the box is not used and no template download occurs`
    );
  }
  vboxKeyWarnings('disks.boot', boot, warnings);
};

const validateAdditionalEntry = (entry, index, errors, warnings) => {
  const where = `disks.additional_disks[${index + 1}]`;
  if (!entry || typeof entry !== 'object' || !entry.type) {
    errors.push(`${where}.type is required (image|blank)`);
    return;
  }
  if (!ADDITIONAL_DISK_TYPES.includes(entry.type)) {
    errors.push(`${where}.type ${entry.type} is not a valid additional disk type (image|blank)`);
    return;
  }
  if (entry.type === 'blank' && !entry.size) {
    errors.push(`${where}.type blank requires size`);
  }
  if (entry.type === 'image' && !entry.path) {
    errors.push(`${where}.type image requires path`);
  }
  if (entry.type === 'image' && (entry.size !== undefined || entry.volume_name !== undefined)) {
    errors.push(`${where}.type image does not take size or volume_name (an image attaches as-is)`);
  }
  if (entry.type === 'blank' && entry.path !== undefined) {
    errors.push(`${where}.type blank does not take path`);
  }
  vboxKeyWarnings(where, entry, warnings);
};

/**
 * Wire-shape validation (synchronous half): the frozen refusal strings +
 * resource_warnings rows. Callers answer 400 with the FIRST error (multi-host
 * prefixes each with "multi-host entry N: ").
 * @param {Object} body - Create body ({settings, disks} post-normalize)
 * @returns {{errors: string[], warnings: Array<{resource: string, message: string}>}}
 */
export const validateDisksWire = body => {
  const errors = [];
  const warnings = [];
  const disks = body.disks || {};

  if (disks.boot) {
    validateBootEntry(disks.boot, body.settings, errors, warnings);
  }
  const additional = Array.isArray(disks.additional_disks) ? disks.additional_disks : [];
  additional.forEach((entry, index) => validateAdditionalEntry(entry, index, errors, warnings));

  const cdroms = Array.isArray(disks.cdroms) ? disks.cdroms : [];
  cdroms.forEach((cdrom, index) => {
    const hasIso = Boolean(cdrom?.iso);
    const hasPath = Boolean(cdrom?.path);
    if (hasIso === hasPath) {
      errors.push(`disks.cdroms[${index + 1}] needs exactly one of iso or path`);
    }
    if (cdrom && typeof cdrom === 'object') {
      vboxKeyWarnings(`disks.cdroms[${index + 1}]`, cdrom, warnings);
    }
  });

  if (disks.controllers !== undefined) {
    warn(warnings, 'disks.controllers is not used on this hypervisor');
  }

  return { errors, warnings };
};

/**
 * Host-truth validation (async half) for image entries: the zvol must exist,
 * and an attached zvol refuses naming the holder unless the ENTRY carries
 * force: true (frozen H3 semantics).
 * @param {Object} disks - The normalized disks block
 * @returns {Promise<string[]>} Frozen refusal strings ([] when clean)
 */
export const validateDiskImages = async disks => {
  const images = [];
  if (disks?.boot?.type === 'image') {
    images.push({ where: 'disks.boot', entry: disks.boot });
  }
  const additional = Array.isArray(disks?.additional_disks) ? disks.additional_disks : [];
  additional.forEach((entry, index) => {
    if (entry?.type === 'image') {
      images.push({ where: `disks.additional_disks[${index + 1}]`, entry });
    }
  });
  if (images.length === 0) {
    return [];
  }

  const errors = [];
  const inUse = await mapZvolDatasetsToZones();
  await Promise.all(
    images.map(async ({ where, entry }) => {
      const exists = await executeCommand(`pfexec zfs list -H -o name "${entry.path}"`);
      if (!exists.success) {
        errors.push(`${where}.path ${entry.path} does not exist on this host`);
        return;
      }
      const holder = inUse.get(entry.path);
      if (holder && entry.force !== true) {
        errors.push(
          `${where}.path ${entry.path} is attached to ${holder} (set force: true to attach anyway)`
        );
      }
    })
  );
  return errors;
};

/**
 * Stamp a dataset the agent CREATED with its recorded provenance — the
 * ownership fact deletion reads (unstamped = foreign = never destroyed).
 * @param {string} dataset - The created dataset/zvol
 * @param {'blank'|'template'|'zone'} source - Provenance value
 * @returns {Promise<void>} Best-effort; a failed stamp is surfaced by throw
 */
export const stampDataset = async (dataset, source) => {
  const result = await executeCommand(`pfexec zfs set ${SOURCE_PROPERTY}=${source} ${dataset}`);
  if (!result.success) {
    throw new Error(`Failed to record provenance on ${dataset}: ${result.error}`);
  }
};

/**
 * Read a dataset's recorded provenance. '-' (unset) reads as null — FOREIGN.
 * @param {string} dataset - Dataset name
 * @returns {Promise<string|null>} Stamp value or null
 */
export const readDatasetSource = async dataset => {
  const result = await executeCommand(`pfexec zfs get -H -o value ${SOURCE_PROPERTY} "${dataset}"`);
  if (!result.success) {
    return null;
  }
  const value = result.output.trim();
  return value && value !== '-' ? value : null;
};
