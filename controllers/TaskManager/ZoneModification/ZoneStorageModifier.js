/**
 * @fileoverview Zone Storage Modifier for Zone Configuration Changes
 * @description Handles adding and removing disks and CD-ROMs from zone configurations via zonecfg
 */

import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import { checkZvolInUse } from '../ZoneCreationManager/index.js';
import {
  resolveCdromPath,
  buildFilesystemCommand,
} from '../ZoneCreationManager/ConfigurationManager.js';
import { syncZoneToDatabase } from '../../../lib/ZoneConfigUtils.js';
import { updateTaskProgress } from '../../../lib/TaskProgressHelper.js';

/**
 * Find the next available disk number in zone config
 * @param {Object} zoneConfig - Zone configuration
 * @returns {number} Next available disk number
 */
const getNextDiskNumber = zoneConfig => {
  let maxNum = -1;

  if (Array.isArray(zoneConfig.attr)) {
    for (const attr of zoneConfig.attr) {
      const match = /^disk(?<num>\d+)$/u.exec(attr.name);
      if (match) {
        const num = parseInt(match.groups.num, 10);
        if (num > maxNum) {
          maxNum = num;
        }
      }
    }
  }

  return maxNum + 1;
};

/**
 * Find the next available cdrom number in zone config
 * @param {Object} zoneConfig - Zone configuration
 * @returns {number} Next available cdrom number
 */
const getNextCdromNumber = zoneConfig => {
  let maxNum = -1;
  let hasBareAttr = false;

  if (Array.isArray(zoneConfig.attr)) {
    for (const attr of zoneConfig.attr) {
      if (attr.name === 'cdrom') {
        hasBareAttr = true;
      }
      const match = /^cdrom(?<num>\d+)$/u.exec(attr.name);
      if (match) {
        const num = parseInt(match.groups.num, 10);
        if (num > maxNum) {
          maxNum = num;
        }
      }
    }
  }

  // If bare 'cdrom' exists, start numbering from 0
  if (hasBareAttr && maxNum === -1) {
    return 0;
  }

  return maxNum + 1;
};

/**
 * Add disks to zone configuration
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Array} disks - Array of disk configurations
 * @param {boolean} force - Whether to force attach in-use datasets
 */
const addDisks = async (zoneName, zoneConfig, disks, force, onData = null) => {
  let nextNum = getNextDiskNumber(zoneConfig);
  const zfsPromises = [];
  const zonecfgCmds = [];

  for (const disk of disks) {
    let diskPath = null;

    if (disk.create_new) {
      const pool = disk.pool || 'rpool';
      const dset = disk.dataset || 'zones';
      const volName = disk.volume_name || `disk${nextNum}`;
      const size = disk.size || '50G';
      diskPath = `${pool}/${dset}/${zoneName}/${volName}`;

      const sparseFlag = disk.sparse !== false ? '-s' : '';
      zfsPromises.push(
        executeCommand(
          `pfexec zfs create ${sparseFlag} -V ${size} ${diskPath}`,
          undefined,
          onData
        ).then(res => {
          if (!res.success) {
            throw new Error(`Failed to create disk volume: ${res.error}`);
          }
          return diskPath;
        })
      );
    } else if (disk.existing_dataset) {
      diskPath = disk.existing_dataset;

      zfsPromises.push(
        checkZvolInUse(diskPath, zoneName).then(usageCheck => {
          if (usageCheck.inUse && !force) {
            throw new Error(`Disk ${diskPath} is already in use by zone ${usageCheck.usedBy}`);
          }
          return diskPath;
        })
      );
    }

    if (diskPath) {
      zonecfgCmds.push(
        `add attr; set name=disk${nextNum}; set value=\\"${diskPath}\\"; set type=string; end; add device; set match=/dev/zvol/rdsk/${diskPath}; end;`
      );
      nextNum++;
    }
  }

  // Wait for ZFS operations
  await Promise.all(zfsPromises);

  // Apply zonecfg
  if (zonecfgCmds.length > 0) {
    const diskResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${zonecfgCmds.join(' ')}"`,
      undefined,
      onData
    );
    if (!diskResult.success) {
      throw new Error(`Failed to add disks to zone: ${diskResult.error}`);
    }
    log.task.info('Added disks to zone', {
      zone_name: zoneName,
      count: disks.length,
    });
  }
};

const SIZE_FACTORS = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };

/**
 * Parse a ZFS size string (e.g. 100G, 1.5T, 524288) to bytes.
 * @param {string|number} size - Size value
 * @returns {number|null} Bytes, or null when unparseable
 */
const parseSizeToBytes = size => {
  const match = String(size)
    .trim()
    .match(/^(?<num>\d+(?:\.\d+)?)(?<unit>[KMGTP]?)B?$/i);
  if (!match) {
    return null;
  }
  return Math.round(parseFloat(match.groups.num) * SIZE_FACTORS[match.groups.unit.toUpperCase()]);
};

/**
 * Resize zone disks (GROW-ONLY — shrinking a zvol destroys data past the new
 * end, so smaller-or-equal targets are refused). Entries select the disk by
 * its ATTR name (bootdisk, disk0, …); the attr's value is the zvol dataset.
 * Never applied live by design: the accrue pipeline holds this until the zone
 * is off (Mark's ruling).
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Array} entries - Array of {name, size}
 */
const resizeDisks = async (zoneName, zoneConfig, entries, onData = null) => {
  const jobs = entries.map(async entry => {
    if (!entry.name || !entry.size) {
      throw new Error('resize_disks entries need name (disk attr) and size');
    }
    const attr = Array.isArray(zoneConfig.attr)
      ? zoneConfig.attr.find(a => a.name === entry.name)
      : null;
    if (!attr || !attr.value) {
      throw new Error(`${entry.name} is not a disk attr on this zone`);
    }
    const diskPath = attr.value;

    const targetBytes = parseSizeToBytes(entry.size);
    if (!targetBytes) {
      throw new Error(`resize_disks size '${entry.size}' is not a valid ZFS size`);
    }

    const currentResult = await executeCommand(
      `pfexec zfs get -H -p -o value volsize ${diskPath}`,
      undefined,
      onData
    );
    if (!currentResult.success) {
      throw new Error(`Cannot read current size of ${diskPath}: ${currentResult.error}`);
    }
    const currentBytes = parseInt(currentResult.output.trim(), 10);

    if (targetBytes === currentBytes) {
      return { name: entry.name, path: diskPath, skipped: 'already that size' };
    }
    if (targetBytes < currentBytes) {
      throw new Error(
        `Refusing to SHRINK ${entry.name} (${diskPath}): ${entry.size} < current ${currentBytes} bytes — shrinking a zvol destroys data`
      );
    }

    const setResult = await executeCommand(
      `pfexec zfs set volsize=${entry.size} ${diskPath}`,
      undefined,
      onData
    );
    if (!setResult.success) {
      throw new Error(`Failed to resize ${entry.name} (${diskPath}): ${setResult.error}`);
    }
    return { name: entry.name, path: diskPath, resized_to: entry.size };
  });

  const results = await Promise.all(jobs);
  log.task.info('Resized zone disks', { zone_name: zoneName, results });
};

/**
 * Remove disks from zone configuration
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Array} diskNames - Array of disk attribute names to remove (e.g., 'disk0')
 */
const removeDisks = async (zoneName, zoneConfig, diskNames, onData = null) => {
  const cmds = [];

  for (const diskName of diskNames) {
    // Find the disk path from current config to remove the device block
    let diskPath = null;
    if (Array.isArray(zoneConfig.attr)) {
      const attr = zoneConfig.attr.find(a => a.name === diskName);
      if (attr) {
        diskPath = attr.value;
      }
    }

    // Remove the attribute
    cmds.push(`remove attr name=${diskName}`);

    // Remove the device block if we found the path
    if (diskPath) {
      cmds.push(`remove device match=/dev/zvol/rdsk/${diskPath}`);
    }
  }

  if (cmds.length > 0) {
    const removeResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${cmds.join('; ')}"`,
      undefined,
      onData
    );
    if (!removeResult.success) {
      throw new Error(`Failed to remove disks: ${removeResult.error}`);
    }
    log.task.info('Removed disks from zone', { zone_name: zoneName, count: diskNames.length });
  }
};

/**
 * Add CD-ROMs to zone configuration
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Array} cdroms - Array of CDROM configurations
 */
const addCdroms = async (zoneName, zoneConfig, cdroms, onData = null) => {
  let nextNum = getNextCdromNumber(zoneConfig);
  const cmds = [];

  // {path} verbatim or {iso} through the artifact registry — the create
  // path's exact resolution (shared contract with the Go agent).
  const resolved = await Promise.all(cdroms.map(cdrom => resolveCdromPath(cdrom)));

  for (const isoPath of resolved.filter(Boolean)) {
    const attrName = `cdrom${nextNum}`;
    cmds.push(
      `add attr; set name=${attrName}; set value=\\"${isoPath}\\"; set type=string; end; add fs; set dir=${isoPath}; set special=${isoPath}; set type=lofs; add options ro; add options nodevices; end;`
    );
    nextNum++;
  }

  if (cmds.length > 0) {
    const cdromResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${cmds.join(' ')}"`,
      undefined,
      onData
    );
    if (!cdromResult.success) {
      throw new Error(`Failed to add CDROMs to zone: ${cdromResult.error}`);
    }
    log.task.info('Added CDROMs to zone', { zone_name: zoneName, count: cdroms.length });
  }
};

/**
 * Remove CD-ROMs from zone configuration
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Array} cdromNames - Array of cdrom attribute names to remove (e.g., 'cdrom0')
 */
const removeCdroms = async (zoneName, zoneConfig, cdromNames, onData = null) => {
  const cmds = [];

  for (const cdromName of cdromNames) {
    // Find the cdrom path from current config to remove the fs block
    let cdromPath = null;
    if (Array.isArray(zoneConfig.attr)) {
      const attr = zoneConfig.attr.find(a => a.name === cdromName);
      if (attr) {
        cdromPath = attr.value;
      }
    }

    // Remove the attribute
    cmds.push(`remove attr name=${cdromName}`);

    // Remove the fs block if we found the path
    if (cdromPath) {
      cmds.push(`remove fs dir=${cdromPath}`);
    }
  }

  if (cmds.length > 0) {
    const removeResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${cmds.join('; ')}"`,
      undefined,
      onData
    );
    if (!removeResult.success) {
      throw new Error(`Failed to remove CDROMs: ${removeResult.error}`);
    }
    log.task.info('Removed CDROMs from zone', { zone_name: zoneName, count: cdromNames.length });
  }
};

/**
 * Add filesystem mounts to zone configuration (generic lofs shares — the
 * create path's filesystems[] shape)
 * @param {string} zoneName - Zone name
 * @param {Array} filesystems - Array of filesystems[] entries
 */
const addFilesystems = async (zoneName, filesystems, onData = null) => {
  const entries = filesystems.filter(entry => entry && entry.special);
  if (entries.length !== filesystems.length) {
    throw new Error('add_filesystems entries need a special (host path)');
  }
  const cmds = entries.map(entry => buildFilesystemCommand(entry));

  if (cmds.length > 0) {
    const fsResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${cmds.join(' ')}"`,
      undefined,
      onData
    );
    if (!fsResult.success) {
      throw new Error(`Failed to add filesystems to zone: ${fsResult.error}`);
    }
    log.task.info('Added filesystems to zone', { zone_name: zoneName, count: entries.length });
  }
};

/**
 * Remove filesystem mounts from zone configuration (by in-zone dir)
 * @param {string} zoneName - Zone name
 * @param {Array} dirs - Array of fs dir values to remove
 */
const removeFilesystems = async (zoneName, dirs, onData = null) => {
  const cmds = dirs.map(dir => `remove fs dir=${dir}`);

  if (cmds.length > 0) {
    const removeResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${cmds.join('; ')}"`,
      undefined,
      onData
    );
    if (!removeResult.success) {
      throw new Error(`Failed to remove filesystems: ${removeResult.error}`);
    }
    log.task.info('Removed filesystems from zone', { zone_name: zoneName, count: dirs.length });
  }
};

/**
 * Handle storage modifications
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Zone configuration
 * @param {Object} metadata - Modification metadata
 * @param {Object} task - Task object
 * @param {Array} changes - Changes array
 */
export const handleStorageModifications = async (
  zoneName,
  zoneConfig,
  metadata,
  task,
  changes,
  onData = null
) => {
  if (metadata.add_disks?.length > 0) {
    await updateTaskProgress(task, 60, { status: 'adding_disks' });
    await addDisks(zoneName, zoneConfig, metadata.add_disks, metadata.force, onData);
    changes.push('add_disks');
    await syncZoneToDatabase(zoneName);
  }

  if (metadata.resize_disks?.length > 0) {
    await updateTaskProgress(task, 65, { status: 'resizing_disks' });
    await resizeDisks(zoneName, zoneConfig, metadata.resize_disks, onData);
    changes.push('resize_disks');
    await syncZoneToDatabase(zoneName);
  }

  if (metadata.remove_disks?.length > 0) {
    await updateTaskProgress(task, 70, { status: 'removing_disks' });
    await removeDisks(zoneName, zoneConfig, metadata.remove_disks, onData);
    changes.push('remove_disks');
    await syncZoneToDatabase(zoneName);
  }

  if (metadata.add_cdroms?.length > 0) {
    await updateTaskProgress(task, 75, { status: 'adding_cdroms' });
    await addCdroms(zoneName, zoneConfig, metadata.add_cdroms, onData);
    changes.push('add_cdroms');
    await syncZoneToDatabase(zoneName);
  }

  if (metadata.remove_cdroms?.length > 0) {
    await updateTaskProgress(task, 80, { status: 'removing_cdroms' });
    await removeCdroms(zoneName, zoneConfig, metadata.remove_cdroms, onData);
    changes.push('remove_cdroms');
    await syncZoneToDatabase(zoneName);
  }

  if (metadata.add_filesystems?.length > 0) {
    await updateTaskProgress(task, 82, { status: 'adding_filesystems' });
    await addFilesystems(zoneName, metadata.add_filesystems, onData);
    changes.push('add_filesystems');
    await syncZoneToDatabase(zoneName);
  }

  if (metadata.remove_filesystems?.length > 0) {
    await updateTaskProgress(task, 84, { status: 'removing_filesystems' });
    await removeFilesystems(zoneName, metadata.remove_filesystems, onData);
    changes.push('remove_filesystems');
    await syncZoneToDatabase(zoneName);
  }
};
