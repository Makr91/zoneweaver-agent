import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import { stampDataset } from '../../../lib/DiskSpec.js';
import { buildDatasetPath } from './utils/ConfigBuilders.js';
import { updateTaskProgress } from '../../../lib/TaskProgressHelper.js';

/**
 * @fileoverview Zone storage preparation — TYPED disk wire (cross-agent disk
 * spec): the boot entry's DECLARED type drives materialization, nothing is
 * inferred from key shapes. Created datasets are stamped with
 * zoneweaver:source provenance (zone root = "zone", fresh zvol = "blank",
 * template clone/copy = "template"); image attaches are NEVER stamped —
 * unstamped datasets are foreign and deletion never touches them.
 */

/**
 * Create the zone's parent/root dataset and stamp it ours.
 * @param {string} rootDataset - The zone root dataset
 * @param {Array} zfsCreated - Rollback tracker
 * @param {Function|null} onData - Output sink
 */
const createZoneRootDataset = async (rootDataset, zfsCreated, onData) => {
  const parentResult = await executeCommand(
    `pfexec zfs create -p ${rootDataset}`,
    undefined,
    onData
  );
  if (!parentResult.success) {
    throw new Error(`Failed to create parent dataset: ${parentResult.error}`);
  }
  zfsCreated.push(rootDataset);
  await stampDataset(rootDataset, 'zone');
};

/**
 * Materialize the boot disk for types image and blank (template runs through
 * importTemplate; none returns null by declaration).
 * @param {Object} metadata - Zone creation metadata (typed disks wire)
 * @param {string} zoneName - Zone name
 * @param {Array} zfsCreated - Array to track created datasets for rollback
 * @returns {Promise<string|null>} Boot disk path or null
 */
export const prepareBootVolume = async (metadata, zoneName, zfsCreated, onData = null) => {
  const boot = metadata.disks?.boot;
  if (!boot || boot.type === 'none' || boot.type === 'template') {
    return null;
  }

  if (boot.type === 'image') {
    // Attach-as-is: never created, never stamped (unstamped = foreign — the
    // deletion path will not touch it). The create pre-flight verified the
    // path; this is the task-time guard.
    const existResult = await executeCommand(`pfexec zfs list -H -o name "${boot.path}"`);
    if (!existResult.success) {
      throw new Error(`disks.boot.path ${boot.path} does not exist on this host`);
    }
    log.task.info('Attaching existing zvol as boot disk', { path: boot.path });
    return boot.path;
  }

  // type: blank — create a fresh zvol and stamp it ours. size is REQUIRED by
  // the wire (validated pre-flight); no silent default.
  const pool = boot.pool || 'rpool';
  const dataset = boot.dataset || 'zones';
  const volumeName = boot.volume_name || 'boot';
  const { size } = boot;
  const rootDataset = buildDatasetPath(`${pool}/${dataset}`, zoneName, metadata.server_id);
  const bootdiskPath = `${rootDataset}/${volumeName}`;

  await createZoneRootDataset(rootDataset, zfsCreated, onData);

  const sparseFlag = boot.sparse !== false ? '-s' : '';
  const zvolResult = await executeCommand(
    `pfexec zfs create ${sparseFlag} -V ${size} ${bootdiskPath}`,
    undefined,
    onData
  );
  if (!zvolResult.success) {
    throw new Error(`Failed to create boot volume: ${zvolResult.error}`);
  }
  await stampDataset(bootdiskPath, 'blank');

  log.task.info('Created boot volume', { path: bootdiskPath, size });
  return bootdiskPath;
};

/**
 * Materialize a type: template boot disk — ZFS clone (default) or full copy,
 * stamped "template". Frozen size rule: absent boot.size KEEPS the template's
 * size; present = grow-to.
 * @param {Object} metadata - Zone creation metadata (typed disks wire)
 * @param {string} zoneName - Zone name
 * @param {Array} zfsCreated - Array to track created datasets for rollback
 * @returns {Promise<string|null>} Target dataset path or null
 */
export const importTemplate = async (metadata, zoneName, zfsCreated, onData = null) => {
  const boot = metadata.disks?.boot;
  if (boot?.type !== 'template') {
    return null;
  }

  const templateDataset = boot.template_dataset;
  if (!templateDataset) {
    throw new Error(
      'disks.boot.type template carries no resolved template_dataset — box resolution failed upstream'
    );
  }
  const snapshot = boot.snapshot_name || 'ready';
  const cloneStrategy = boot.clone_strategy || 'clone';
  const pool = boot.pool || 'rpool';
  const dataset = boot.dataset || 'zones';
  const volumeName = boot.volume_name || 'boot';
  const parentDataset = buildDatasetPath(`${pool}/${dataset}`, zoneName, metadata.server_id);
  const targetDataset = `${parentDataset}/${volumeName}`;

  await createZoneRootDataset(parentDataset, zfsCreated, onData);

  if (cloneStrategy === 'copy') {
    const sendRecvResult = await executeCommand(
      `pfexec zfs send ${templateDataset}@${snapshot} | pfexec zfs recv -F ${targetDataset}`,
      3600 * 1000,
      onData
    );
    if (!sendRecvResult.success) {
      throw new Error(`Template import failed: ${sendRecvResult.error}`);
    }
  } else {
    const cloneResult = await executeCommand(
      `pfexec zfs clone ${templateDataset}@${snapshot} ${targetDataset}`,
      undefined,
      onData
    );
    if (!cloneResult.success) {
      throw new Error(`Template clone failed: ${cloneResult.error}`);
    }
  }

  zfsCreated.push(targetDataset);
  await stampDataset(targetDataset, 'template');

  // Frozen rule: absent size = the template's own size stands.
  if (boot.size) {
    const resizeResult = await executeCommand(
      `pfexec zfs set volsize=${boot.size} ${targetDataset}`,
      undefined,
      onData
    );
    if (!resizeResult.success) {
      log.task.warn('Failed to resize boot volume', {
        target: targetDataset,
        requested_size: boot.size,
        error: resizeResult.error,
      });
    } else {
      log.task.info('Boot volume resized', { target: targetDataset, size: boot.size });
    }
  }

  log.task.info('Template imported', { template: templateDataset, target: targetDataset });
  return targetDataset;
};

/**
 * Prepare storage: materialize the DECLARED boot type.
 * @param {Object} metadata - Zone creation metadata (typed disks wire)
 * @param {string} zoneName - Zone name
 * @param {Array} zfsCreated - Array to track created datasets for rollback
 * @param {Object} task - Task object for progress updates
 * @returns {Promise<string|null>} Boot disk path or null
 */
export const prepareStorage = async (metadata, zoneName, zfsCreated, task, onData = null) => {
  await updateTaskProgress(task, 10, { status: 'preparing_storage' });
  let bootdiskPath = await prepareBootVolume(metadata, zoneName, zfsCreated, onData);

  if (metadata.disks?.boot?.type === 'template') {
    await updateTaskProgress(task, 30, { status: 'importing_template' });
    bootdiskPath = await importTemplate(metadata, zoneName, zfsCreated, onData);
  }

  return bootdiskPath;
};
