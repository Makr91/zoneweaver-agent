/**
 * @fileoverview Machine disk (zvol) resize — Mark's ruling: gate the truncate,
 * ungate the grow.
 *
 * GROW applies IMMEDIATELY, live, no power cycle and no accrue. Proven on
 * host-1162 (running zone, `zfs set volsize=401G` → the guest kernel logged
 * "detected capacity change" unprompted), and confirmed in the bhyve source
 * illumos ships: pci_virtio_block.c registers pci_vtblk_resized(), which
 * updates the cached capacity and fires vq_devcfg_changed(); pci_nvme.c
 * registers pci_nvme_resized(), which recomputes the namespace size. The only
 * gate on a grow is CAPACITY — a grow the pool cannot back would over-provision
 * it into a guest-corrupting ENOSPC later.
 *
 * SHRINK is gated hard: ZFS truncates the volume, so the guest filesystem loses
 * everything past the new end. It needs an explicit per-entry flag AND a
 * powered-off machine.
 *
 * AHCI IS THE EXCEPTION: pci_ahci.c registers NO resize callback — it reads
 * blockif_size() once in ata_identify_init() and bakes it into the IDENTIFY
 * data, so an ahci/ide guest keeps reporting the OLD capacity until it is power
 * cycled. The answer says so per disk (requires_restart).
 */

import { executeCommand } from './CommandManager.js';
import { readZonecfgAttr, setDocumentDiskSize } from './ZoneConfigUtils.js';
import { log } from './Logger.js';

const SIZE_FACTORS = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };

/**
 * The bhyve block backends that refresh guest-visible capacity LIVE (they
 * register a blockif resize callback). Anything else — ahci, ahci-hd, ide —
 * bakes the size into its identify data at attach and needs a power cycle.
 */
const LIVE_RESIZE_DISKIFS = new Set(['virtio', 'virtio-blk', 'nvme']);

/** The brand's diskif default when the zone sets no attr (/usr/lib/brand/bhyve/boot). */
const BRAND_DEFAULT_DISKIF = 'virtio-blk';

/**
 * Parse a ZFS size string (100G, 1.5T, 524288) to bytes.
 * @param {string|number} size - Size value
 * @returns {number|null} Bytes, or null when unparseable
 */
export const parseSizeToBytes = size => {
  const match = String(size)
    .trim()
    .match(/^(?<num>\d+(?:\.\d+)?)(?<unit>[KMGTP]?)B?$/i);
  if (!match) {
    return null;
  }
  return Math.round(parseFloat(match.groups.num) * SIZE_FACTORS[match.groups.unit.toUpperCase()]);
};

/**
 * Read one numeric ZFS property in bytes.
 * @param {string} dataset - Dataset name
 * @param {string} property - Property name
 * @returns {Promise<string>} Raw property value
 * @throws {Error} When the read fails
 */
const readZfsProperty = async (dataset, property) => {
  const result = await executeCommand(`pfexec zfs get -H -p -o value ${property} ${dataset}`);
  if (!result.success) {
    throw new Error(`Cannot read ${property} of ${dataset}: ${result.error}`);
  }
  return result.output.trim();
};

/**
 * The backend a given disk actually runs on. The boot disk always uses the
 * zone-level diskif; additional disks may override it with a diskif<N> attr
 * (the brand boot program's own rule). Unset anywhere → the brand default.
 * @param {string} zoneName - Zone name
 * @param {string} diskAttr - Disk attr name (bootdisk, disk0, …)
 * @returns {Promise<string>} Effective diskif
 */
const effectiveDiskif = async (zoneName, diskAttr) => {
  const indexMatch = diskAttr.match(/^disk(?<index>\d+)$/);
  if (indexMatch) {
    const override = await readZonecfgAttr(zoneName, `diskif${indexMatch.groups.index}`);
    if (override.exists && override.value) {
      return override.value;
    }
  }
  const zoneDiskif = await readZonecfgAttr(zoneName, 'diskif');
  return zoneDiskif.exists && zoneDiskif.value ? zoneDiskif.value : BRAND_DEFAULT_DISKIF;
};

/**
 * Resolve a disk attr to its zvol dataset.
 * @param {Object} zoneConfig - Live zone configuration (zadm view)
 * @param {string} diskAttr - Disk attr name
 * @returns {string} The zvol dataset
 * @throws {Error} When the attr is not a disk on this machine
 */
const datasetForDisk = (zoneConfig, diskAttr) => {
  const attr = Array.isArray(zoneConfig?.attr)
    ? zoneConfig.attr.find(a => a.name === diskAttr)
    : null;
  if (!attr || !attr.value) {
    throw new Error(`${diskAttr} is not a disk on this machine`);
  }
  return attr.value;
};

/**
 * Refuse a grow the pool cannot back. A thick zvol's refreservation must find
 * the delta immediately; a sparse one would merely over-provision — but that
 * ends in a guest-corrupting ENOSPC the first time the guest fills it, which
 * is exactly what Mark's ruling forbids. `allow_overprovision: true` overrides
 * for operators who thin-provision deliberately.
 * @param {string} dataset - The zvol
 * @param {number} deltaBytes - How much the volume grows by
 * @param {boolean} allowOverprovision - Explicit override
 * @throws {Error} When the pool cannot back the growth
 */
const assertPoolCanBack = async (dataset, deltaBytes, allowOverprovision) => {
  if (allowOverprovision === true) {
    return;
  }
  const [pool] = dataset.split('/');
  const available = Number(await readZfsProperty(pool, 'available'));
  if (!Number.isFinite(available) || deltaBytes <= available) {
    return;
  }
  throw new Error(
    `Refusing to grow ${dataset}: it needs ${deltaBytes} more bytes but pool ${pool} has only ${available} available. ` +
      'Growing anyway would over-provision the pool and the guest would hit ENOSPC (and likely corrupt) once it filled the space. ' +
      'Free space in the pool, or set allow_overprovision: true on this entry if you thin-provision deliberately.'
  );
};

/**
 * Apply one resize entry.
 * @param {Object} context - {zoneName, zoneConfig, poweredOff}
 * @param {Object} entry - {name, size, allow_shrink?, allow_overprovision?}
 * @returns {Promise<Object>} Per-disk result
 */
const resizeOne = async ({ zoneName, zoneConfig, poweredOff }, entry) => {
  if (!entry.name || !entry.size) {
    throw new Error('resize_disks entries need name (the disk, e.g. bootdisk or disk0) and size');
  }
  const dataset = datasetForDisk(zoneConfig, entry.name);

  const targetBytes = parseSizeToBytes(entry.size);
  if (!targetBytes) {
    throw new Error(`resize_disks size '${entry.size}' is not a valid ZFS size`);
  }

  const currentBytes = Number(await readZfsProperty(dataset, 'volsize'));
  if (targetBytes === currentBytes) {
    return { name: entry.name, dataset, skipped: 'already that size' };
  }

  const shrinking = targetBytes < currentBytes;

  if (shrinking) {
    if (entry.allow_shrink !== true) {
      throw new Error(
        `${entry.name} (${dataset}): ${entry.size} is SMALLER than the current ${currentBytes} bytes. ` +
          'Shrinking TRUNCATES the volume — the guest filesystem loses everything past the new end and will most likely not boot. ' +
          'Set allow_shrink: true on this entry to proceed anyway.'
      );
    }
    if (!poweredOff) {
      throw new Error(
        `${entry.name} (${dataset}): refusing to shrink a RUNNING machine — truncating a mounted volume corrupts it. ` +
          'Power the machine off first.'
      );
    }
  } else {
    await assertPoolCanBack(dataset, targetBytes - currentBytes, entry.allow_overprovision);
  }

  if (shrinking) {
    log.task.warn('SHRINKING a machine disk — data past the new end is destroyed', {
      zone_name: zoneName,
      disk: entry.name,
      dataset,
      current_bytes: currentBytes,
      target_size: entry.size,
      target_bytes: targetBytes,
    });
  }

  const setResult = await executeCommand(`pfexec zfs set volsize=${entry.size} ${dataset}`);
  if (!setResult.success) {
    throw new Error(`Failed to resize ${entry.name} (${dataset}): ${setResult.error}`);
  }

  // The machine document's `disks` section OVERLAYS zadm's live view on the
  // detail GET, so it has to learn the new size too — otherwise the API keeps
  // answering the create-time size while the zvol is a different size.
  await setDocumentDiskSize(zoneName, entry.name, dataset, entry.size);

  // Whether the GUEST sees the new size without a power cycle depends on the
  // backend: virtio-blk and nvme register a blockif resize callback, ahci does
  // not (it bakes the size into its IDENTIFY data at attach).
  const diskif = await effectiveDiskif(zoneName, entry.name);
  const guestSeesItLive = LIVE_RESIZE_DISKIFS.has(diskif);

  return {
    name: entry.name,
    dataset,
    diskif,
    previous_bytes: currentBytes,
    resized_to: entry.size,
    shrunk: shrinking || undefined,
    // A powered-off machine reads the new size at its next boot regardless.
    requires_restart: !poweredOff && !guestSeesItLive,
  };
};

/**
 * Resize a machine's disks. Applied IMMEDIATELY — resize_disks never accrues
 * (Mark's ruling: grow is non-destructive at the ZFS layer and lands live).
 * @param {Object} params - {zoneName, zoneConfig, entries, poweredOff}
 * @returns {Promise<{results: Array<Object>, requires_restart: boolean}>}
 * @throws {Error} On any refusal or failure (nothing is half-applied per entry)
 */
export const resizeMachineDisks = async ({ zoneName, zoneConfig, entries, poweredOff }) => {
  const context = { zoneName, zoneConfig, poweredOff };
  // Sequential on purpose: each entry reads pool free space, and two grows
  // racing that read could both pass a check only one of them can afford.
  const results = [];
  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await resizeOne(context, entry));
  }

  log.task.info('Resized machine disks', { zone_name: zoneName, results });

  return {
    results,
    requires_restart: results.some(result => result.requires_restart),
  };
};
