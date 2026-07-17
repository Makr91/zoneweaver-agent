/**
 * @fileoverview Zone snapshot task executors (snapshot_take / snapshot_restore / snapshot_delete)
 * @description The Go agent's snapshot family translated to this hypervisor's native power:
 * ZFS snapshots over the zone's WHOLE tree — the zone root dataset recursively (path,
 * provisioning, in-tree zvols; Snapshoter.sh's -r semantics) plus any out-of-tree media
 * (bootdisk/diskN on other pools). Restore refuses running zones. Optional quiesce runs
 * qga fsfreeze-freeze/thaw around the snapshot (application-consistent when the guest
 * agent answers; crash-consistent otherwise, never blocking).
 */

import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import { updateTaskProgress, parseTaskMetadata } from '../../lib/TaskProgressHelper.js';
import { getZoneConfig } from '../../lib/ZoneConfigUtils.js';
import { hasSuspendCheckpoint, deleteSuspendCheckpoint } from '../../lib/SuspendCheckpoint.js';
import { isGuestAgentEnabled, guestSocketPath, runGuestCommand } from '../../lib/QemuGuestAgent.js';
import Zones from '../../models/ZoneModel.js';

const parseSnapshotMetadata = async (task, { allowPrefix = false } = {}) => {
  const result = await parseTaskMetadata(task);
  if (!result?.snapshot_name && !(allowPrefix && result?.prefix)) {
    throw new Error('snapshot task metadata has no snapshot_name');
  }
  return result;
};

export const timestampSuffix = (date = new Date()) => {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
};

/**
 * The zone's snapshot targets: the zone ROOT dataset (recursive — covers
 * path, provisioning, and every in-tree zvol) plus media living outside it.
 * @param {Object} zoneConfig - Live zadm configuration
 * @returns {{root: string|null, externals: string[]}}
 */
export const collectSnapshotTargets = zoneConfig => {
  const root =
    typeof zoneConfig.zonepath === 'string' && zoneConfig.zonepath
      ? zoneConfig.zonepath.replace(/^\/+/u, '').replace(/\/path$/u, '')
      : null;
  const externals = [];
  for (const [key, value] of Object.entries(zoneConfig)) {
    if ((key === 'bootdisk' || /^disk\d+$/u.test(key)) && typeof value === 'string' && value) {
      if (!root || (value !== root && !value.startsWith(`${root}/`))) {
        externals.push(value);
      }
    }
  }
  return { root, externals };
};

const resolveTargets = async zoneName => {
  const zoneConfig = await getZoneConfig(zoneName);
  const targets = collectSnapshotTargets(zoneConfig);
  if (!targets.root && targets.externals.length === 0) {
    throw new Error('Zone has no ZFS datasets to snapshot');
  }
  return { ...targets, zoneConfig };
};

const zoneIsRunning = async zoneName => {
  const result = await executeCommand(`pfexec zoneadm -z ${zoneName} list -p`);
  return result.success && result.output.split(':')[2] === 'running';
};

const runSequentially = (items, fn) =>
  items.reduce((promise, item, index) => promise.then(() => fn(item, index)), Promise.resolve());

export const scrubIdle = async pool => {
  const result = await executeCommand(`pfexec zpool status ${pool}`);
  return result.success && /scan:.*(?:repaired|none|resilvered)/u.test(result.output);
};

/**
 * Snapshoter.sh's rotation prune: newest `retention` snapshots matching the
 * prefix survive; deletion is skipped entirely while the pool scrubs or
 * resilvers.
 */
export const pruneSnapshots = async (dataset, prefix, retention, onData, recurse = false) => {
  const [pool] = dataset.split('/');
  if (!(await scrubIdle(pool))) {
    onData?.({
      stream: 'stdout',
      data: `Pool ${pool} is scrubbing/resilvering — snapshot pruning skipped this round\n`,
    });
    return;
  }
  const list = await executeCommand(
    `pfexec zfs list -H -t snapshot -o name -s creation -d 1 ${dataset}`
  );
  if (!list.success) {
    return;
  }
  const matching = list.output
    .split('\n')
    .map(line => line.trim())
    .filter(name => name.startsWith(`${dataset}@${prefix}-`));
  const excess = matching.length - retention;
  if (excess <= 0) {
    return;
  }
  const flag = recurse ? '-r ' : '';
  await runSequentially(matching.slice(0, excess), async name => {
    onData?.({ stream: 'stdout', data: `Pruning ${name}\n` });
    const result = await executeCommand(`pfexec zfs destroy ${flag}${name}`, undefined, onData);
    if (!result.success) {
      onData?.({ stream: 'stderr', data: `${name}: ${result.error}\n` });
    }
  });
};

/**
 * Age prune: destroy prefix-matching snapshots older than maxAgeDays
 * (scrub-guarded like the rotation prune).
 */
export const pruneSnapshotsByAge = async (dataset, prefix, maxAgeDays, onData, recurse = false) => {
  const [pool] = dataset.split('/');
  if (!(await scrubIdle(pool))) {
    return;
  }
  const list = await executeCommand(
    `pfexec zfs list -H -p -t snapshot -o name,creation -s creation -d 1 ${dataset}`
  );
  if (!list.success) {
    return;
  }
  const cutoff = Date.now() / 1000 - maxAgeDays * 86400;
  const flag = recurse ? '-r ' : '';
  const expired = list.output
    .split('\n')
    .map(line => line.trim().split('\t'))
    .filter(
      ([name, creation]) => name?.startsWith(`${dataset}@${prefix}-`) && Number(creation) < cutoff
    );
  await runSequentially(expired, async ([name]) => {
    onData?.({ stream: 'stdout', data: `Pruning ${name} (aged out)\n` });
    const result = await executeCommand(`pfexec zfs destroy ${flag}${name}`, undefined, onData);
    if (!result.success) {
      onData?.({ stream: 'stderr', data: `${name}: ${result.error}\n` });
    }
  });
};

/**
 * qga fsfreeze around a snapshot — application-consistent when the guest
 * agent answers; a silent/absent agent narrates and the snapshot proceeds
 * crash-consistent. Returns a thaw function (always safe to call).
 */
const freezeGuest = async (zoneName, zoneConfig, onData) => {
  const noop = () => Promise.resolve();
  if (!isGuestAgentEnabled() || !zoneConfig.zonepath || !(await zoneIsRunning(zoneName))) {
    return noop;
  }
  const socket = guestSocketPath(zoneConfig.zonepath);
  try {
    await runGuestCommand(socket, 'guest-fsfreeze-freeze', null, 10000);
    onData?.({ stream: 'stdout', data: 'Guest filesystems frozen (qga fsfreeze)\n' });
    return async () => {
      try {
        await runGuestCommand(socket, 'guest-fsfreeze-thaw', null, 10000);
        onData?.({ stream: 'stdout', data: 'Guest filesystems thawed\n' });
      } catch (error) {
        onData?.({ stream: 'stderr', data: `fsfreeze thaw failed: ${error.message}\n` });
      }
    };
  } catch (error) {
    onData?.({
      stream: 'stdout',
      data: `Guest agent fsfreeze unavailable (${error.message}) — snapshot proceeds crash-consistent\n`,
    });
    return noop;
  }
};

const snapshotTargets = async (targets, snapshotName, onData) => {
  if (targets.root) {
    onData?.({
      stream: 'stdout',
      data: `Snapshotting ${targets.root}@${snapshotName} (recursive)\n`,
    });
    const result = await executeCommand(
      `pfexec zfs snapshot -r ${targets.root}@${snapshotName}`,
      undefined,
      onData
    );
    if (!result.success) {
      throw new Error(`Snapshot of ${targets.root} failed: ${result.error}`);
    }
  }
  await runSequentially(targets.externals, async dataset => {
    onData?.({ stream: 'stdout', data: `Snapshotting ${dataset}@${snapshotName}\n` });
    const result = await executeCommand(
      `pfexec zfs snapshot ${dataset}@${snapshotName}`,
      undefined,
      onData
    );
    if (!result.success) {
      throw new Error(`Snapshot of ${dataset} failed: ${result.error}`);
    }
  });
};

export const executeSnapshotTakeTask = async task => {
  const { zone_name } = task;
  try {
    const metadata = await parseSnapshotMetadata(task, { allowPrefix: true });
    const { description, live, prefix, retention = 0, quiesce = false } = metadata;
    const snapshotName = metadata.snapshot_name || `${prefix}-${timestampSuffix()}`;
    const { onData } = task;
    const targets = await resolveTargets(zone_name);

    if (live) {
      onData?.({
        stream: 'stdout',
        data: 'ZFS snapshots are crash-consistent without pausing — live flag has no effect here\n',
      });
    }

    await updateTaskProgress(task, 20, { status: 'taking_snapshots' });
    const thaw = quiesce
      ? await freezeGuest(zone_name, targets.zoneConfig, onData)
      : () => Promise.resolve();
    try {
      await snapshotTargets(targets, snapshotName, onData);
    } finally {
      await thaw();
    }
    if (description && targets.root) {
      await executeCommand(
        `pfexec zfs set zoneweaver:description="${description}" ${targets.root}@${snapshotName}`
      );
    }

    if (prefix && retention > 0) {
      await updateTaskProgress(task, 92, { status: 'pruning_snapshots' });
      if (targets.root) {
        await pruneSnapshots(targets.root, prefix, retention, onData, true);
      }
      await runSequentially(targets.externals, dataset =>
        pruneSnapshots(dataset, prefix, retention, onData)
      );
    }
    const maxAgeDays = Number(metadata.max_age_days) || 0;
    if (prefix && maxAgeDays > 0) {
      await updateTaskProgress(task, 95, { status: 'pruning_snapshots' });
      if (targets.root) {
        await pruneSnapshotsByAge(targets.root, prefix, maxAgeDays, onData, true);
      }
      await runSequentially(targets.externals, dataset =>
        pruneSnapshotsByAge(dataset, prefix, maxAgeDays, onData)
      );
    }

    await updateTaskProgress(task, 100, { status: 'completed' });
    return { success: true, message: `Snapshot ${snapshotName} taken` };
  } catch (error) {
    log.task.error('Snapshot take failed', { zone_name, error: error.message });
    return { success: false, error: `Snapshot failed: ${error.message}` };
  }
};

export const executeSnapshotRestoreTask = async task => {
  const { zone_name } = task;
  try {
    const metadata = await parseSnapshotMetadata(task);
    const { snapshot_name } = metadata;
    const { onData } = task;

    if (await zoneIsRunning(zone_name)) {
      return {
        success: false,
        error: 'Zone is running — snapshots restore onto powered-off zones only; stop it first',
      };
    }

    const targets = await resolveTargets(zone_name);
    const datasets = [];
    if (targets.root) {
      const list = await executeCommand(
        `pfexec zfs list -H -t snapshot -o name -r ${targets.root}`
      );
      if (list.success) {
        for (const line of list.output.split('\n')) {
          const name = line.trim();
          if (name.endsWith(`@${snapshot_name}`)) {
            datasets.push(name.slice(0, -(snapshot_name.length + 1)));
          }
        }
      }
    }
    datasets.push(...targets.externals);
    if (datasets.length === 0) {
      return { success: false, error: `Snapshot ${snapshot_name} was not found` };
    }

    await updateTaskProgress(task, 20, { status: 'restoring_snapshots' });
    await runSequentially(datasets, async dataset => {
      onData?.({ stream: 'stdout', data: `Rolling back ${dataset} to @${snapshot_name}\n` });
      const result = await executeCommand(
        `pfexec zfs rollback -r ${dataset}@${snapshot_name}`,
        undefined,
        onData
      );
      if (!result.success) {
        throw new Error(`Rollback of ${dataset} failed: ${result.error}`);
      }
    });

    // A suspend checkpoint references the PRE-rollback disks — resuming from
    // it now would time-travel the guest. Discard it, narrated.
    if (targets.zoneConfig.zonepath && (await hasSuspendCheckpoint(targets.zoneConfig.zonepath))) {
      onData?.({
        stream: 'stdout',
        data: 'Suspend checkpoint discarded — it referenced the pre-rollback disk state\n',
      });
      await deleteSuspendCheckpoint(targets.zoneConfig.zonepath);
      await Zones.update(
        { status: 'installed' },
        { where: { name: zone_name, status: 'suspended' } }
      );
    }

    await updateTaskProgress(task, 100, { status: 'completed' });
    return { success: true, message: `Zone restored to snapshot ${snapshot_name}` };
  } catch (error) {
    log.task.error('Snapshot restore failed', { zone_name, error: error.message });
    return { success: false, error: `Snapshot restore failed: ${error.message}` };
  }
};

/**
 * Rename a snapshot and/or edit its description (snapshot_modify — the
 * shared PUT /machines/{name}/snapshots/{snapshot} wire). Rename walks the
 * whole tree (`zfs rename -r` on the root + per-external renames); the
 * description rides the zone-root snapshot's zoneweaver:description user
 * property (exactly where snapshot_take writes it — an empty string clears
 * it via zfs inherit).
 */
export const executeSnapshotModifyTask = async task => {
  const { zone_name } = task;
  try {
    const metadata = await parseSnapshotMetadata(task);
    const { snapshot_name, new_name, description } = metadata;
    const { onData } = task;
    const targets = await resolveTargets(zone_name);

    let currentName = snapshot_name;
    if (new_name && new_name !== snapshot_name) {
      await updateTaskProgress(task, 20, { status: 'renaming_snapshots' });
      let renamed = 0;
      if (targets.root) {
        onData?.({
          stream: 'stdout',
          data: `Renaming ${targets.root}@${snapshot_name} → @${new_name} (recursive)\n`,
        });
        const result = await executeCommand(
          `pfexec zfs rename -r ${targets.root}@${snapshot_name} ${targets.root}@${new_name}`,
          undefined,
          onData
        );
        if (result.success) {
          renamed++;
        } else {
          onData?.({
            stream: 'stderr',
            data: `${targets.root}@${snapshot_name}: ${result.error}\n`,
          });
        }
      }
      await runSequentially(targets.externals, async dataset => {
        const result = await executeCommand(
          `pfexec zfs rename ${dataset}@${snapshot_name} ${dataset}@${new_name}`,
          undefined,
          onData
        );
        if (result.success) {
          renamed++;
        } else {
          onData?.({ stream: 'stderr', data: `${dataset}@${snapshot_name}: ${result.error}\n` });
        }
      });
      if (renamed === 0) {
        return {
          success: false,
          error: `Snapshot ${snapshot_name} could not be renamed on any dataset`,
        };
      }
      currentName = new_name;
    }

    if (description !== undefined && targets.root) {
      await updateTaskProgress(task, 70, { status: 'setting_description' });
      const command = description
        ? `pfexec zfs set zoneweaver:description="${description}" ${targets.root}@${currentName}`
        : `pfexec zfs inherit zoneweaver:description ${targets.root}@${currentName}`;
      const result = await executeCommand(command, undefined, onData);
      if (!result.success) {
        return { success: false, error: `Description update failed: ${result.error}` };
      }
    }

    await updateTaskProgress(task, 100, { status: 'completed' });
    return {
      success: true,
      message:
        new_name && new_name !== snapshot_name
          ? `Snapshot ${snapshot_name} renamed to ${currentName}`
          : `Snapshot ${currentName} description updated`,
    };
  } catch (error) {
    log.task.error('Snapshot modify failed', { zone_name, error: error.message });
    return { success: false, error: `Snapshot modify failed: ${error.message}` };
  }
};

export const executeSnapshotDeleteTask = async task => {
  const { zone_name } = task;
  try {
    const metadata = await parseSnapshotMetadata(task);
    const { snapshot_name } = metadata;
    const { onData } = task;
    const targets = await resolveTargets(zone_name);

    await updateTaskProgress(task, 20, { status: 'deleting_snapshots' });
    let deleted = 0;
    if (targets.root) {
      const result = await executeCommand(
        `pfexec zfs destroy -r ${targets.root}@${snapshot_name}`,
        undefined,
        onData
      );
      if (result.success) {
        deleted++;
      } else {
        onData?.({ stream: 'stderr', data: `${targets.root}@${snapshot_name}: ${result.error}\n` });
      }
    }
    await runSequentially(targets.externals, async dataset => {
      const result = await executeCommand(
        `pfexec zfs destroy ${dataset}@${snapshot_name}`,
        undefined,
        onData
      );
      if (result.success) {
        deleted++;
      } else {
        onData?.({ stream: 'stderr', data: `${dataset}@${snapshot_name}: ${result.error}\n` });
      }
    });
    if (deleted === 0) {
      return { success: false, error: `Snapshot ${snapshot_name} was not found on any dataset` };
    }

    await updateTaskProgress(task, 100, { status: 'completed' });
    return { success: true, message: `Snapshot ${snapshot_name} deleted` };
  } catch (error) {
    log.task.error('Snapshot delete failed', { zone_name, error: error.message });
    return { success: false, error: `Snapshot delete failed: ${error.message}` };
  }
};
