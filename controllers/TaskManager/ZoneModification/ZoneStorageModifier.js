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
import { appendDocumentDisks, removeDocumentDisks } from '../../../lib/ZoneConfigMutators.js';
import { stampDataset, getRootPool } from '../../../lib/DiskSpec.js';
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
 * Add disks to zone configuration — TYPED entries ONLY (the frozen disk
 * spec adopted by the modify wire, converged 2026-07-18): blank creates a
 * fresh zvol (size REQUIRED — no default) and stamps it ours; image
 * attaches the declared path as-is (never stamped; per-ENTRY force
 * overrides the in-use refusal). The executor re-enforces the wire shape
 * the controller already refused at the PUT.
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Array} disks - Typed add_disks[] entries
 */
const addDisks = async (zoneName, zoneConfig, disks, onData = null) => {
  let nextNum = getNextDiskNumber(zoneConfig);
  const zfsPromises = [];
  const zonecfgCmds = [];
  const documentEntries = [];
  const rootPool = await getRootPool();

  for (const [index, disk] of disks.entries()) {
    let diskPath = null;

    if (disk?.type === 'blank') {
      if (!disk.size) {
        throw new Error(`add_disks[${index + 1}].type blank requires size`);
      }
      const pool = disk.pool || rootPool;
      const dset = disk.dataset || 'zones';
      const volName = disk.volume_name || `disk${nextNum}`;
      diskPath = `${pool}/${dset}/${zoneName}/${volName}`;

      const sparseFlag = disk.sparse !== false ? '-s' : '';
      const createdPath = diskPath;
      zfsPromises.push(
        executeCommand(
          `pfexec zfs create ${sparseFlag} -V ${disk.size} ${diskPath}`,
          undefined,
          onData
        ).then(async res => {
          if (!res.success) {
            throw new Error(`Failed to create disk volume: ${res.error}`);
          }
          // Ownership stamp (frozen disk spec): created = ours.
          await stampDataset(createdPath, 'blank');
          return createdPath;
        })
      );
      documentEntries.push({
        type: 'blank',
        pool,
        dataset: dset,
        volume_name: volName,
        size: disk.size,
        sparse: disk.sparse !== false,
      });
    } else if (disk?.type === 'image') {
      if (!disk.path) {
        throw new Error(`add_disks[${index + 1}].type image requires path`);
      }
      diskPath = disk.path;

      zfsPromises.push(
        checkZvolInUse(diskPath, zoneName).then(usageCheck => {
          if (usageCheck.inUse && disk.force !== true) {
            throw new Error(
              `add_disks[${index + 1}].path ${diskPath} is attached to ${usageCheck.usedBy} (set force: true to attach anyway)`
            );
          }
          return diskPath;
        })
      );
      // Attach = image in the typed document (never stamped — foreign).
      documentEntries.push({ type: 'image', path: diskPath });
    } else {
      throw new Error(`add_disks[${index + 1}].type is required (image|blank)`);
    }

    zonecfgCmds.push(
      `add attr; set name=disk${nextNum}; set value=\\"${diskPath}\\"; set type=string; end; add device; set match=/dev/zvol/rdsk/${diskPath}; end;`
    );
    nextNum++;
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
    // Document honesty: the document's typed disks block learns the new
    // disks too (the resize pattern generalized).
    await appendDocumentDisks(zoneName, documentEntries);
    log.task.info('Added disks to zone', {
      zone_name: zoneName,
      count: disks.length,
    });
  }
};

/**
 * Remove disks from zone configuration
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Array} diskNames - Array of disk attribute names to remove (e.g., 'disk0')
 */
const removeDisks = async (zoneName, zoneConfig, diskNames, onData = null) => {
  const cmds = [];
  const removedPaths = [];

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
      removedPaths.push(diskPath);
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
    // Document honesty: drop the removed disks from the document's typed
    // disks block too.
    if (removedPaths.length > 0) {
      await removeDocumentDisks(zoneName, removedPaths);
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
    await addDisks(zoneName, zoneConfig, metadata.add_disks, onData);
    changes.push('add_disks');
    await syncZoneToDatabase(zoneName);
  }

  // resize_disks is NOT handled here: it applies immediately in the controller
  // (lib/MachineDiskResize.js) — it never accrues and never queues.

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
