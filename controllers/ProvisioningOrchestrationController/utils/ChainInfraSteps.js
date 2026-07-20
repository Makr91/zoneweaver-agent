import { log } from '../../../lib/Logger.js';
import {
  createTask,
  createSequentialTransferTasks,
  syncbackEligibleFolders,
  shouldSkipZoneSetup,
} from './TaskCreationHelper.js';

/**
 * Step 0: land the provisioning content — uploaded artifact, or the
 * referenced registry package (create-from-package zones). The chain's
 * first task gates on ctx.firstDependsOn (the ensure hook's setup chain).
 * @param {Object} ctx - Chain context
 * @param {Object} zoneConfig - Parsed zone configuration
 * @param {string} provisioningDatasetPath - Provisioning dataset mountpoint
 * @returns {Promise<string|null>} The step's task id (null when no content step)
 */
export const queueContentStep = async (ctx, zoneConfig, provisioningDatasetPath) => {
  if (ctx.artifactId) {
    const extractTask = await createTask({
      zone_name: ctx.zoneName,
      operation: 'zone_provisioning_extract',
      metadata: {
        artifact_id: ctx.artifactId,
        dataset_path: provisioningDatasetPath,
      },
      depends_on: ctx.firstDependsOn ?? null,
      parent_task_id: ctx.parentTaskId,
      created_by: ctx.createdBy,
    });
    ctx.taskChain.push({ step: 'extract', task_id: extractTask.id });
    return extractTask.id;
  }
  if (zoneConfig.provisioner_ref?.name) {
    const stageTask = await createTask({
      zone_name: ctx.zoneName,
      operation: 'zone_provisioning_stage',
      metadata: {
        provisioner_name: zoneConfig.provisioner_ref.name,
        provisioner_version: zoneConfig.provisioner_ref.version,
        dataset_path: provisioningDatasetPath,
      },
      depends_on: ctx.firstDependsOn ?? null,
      parent_task_id: ctx.parentTaskId,
      created_by: ctx.createdBy,
    });
    ctx.taskChain.push({ step: 'stage', task_id: stageTask.id });
    return stageTask.id;
  }
  return null;
};

/**
 * Steps 1-2: boot the zone (when needed) and run the zlogin recipe (skipped
 * when SSH already answers).
 * @param {Object} ctx - Chain context
 * @param {string|null} previousTaskId - Outer-chain dependency
 * @returns {Promise<string|null>} The chain's new previous task id
 */
export const queueBootAndSetupSteps = async (ctx, previousTaskId) => {
  let prev = previousTaskId;

  if (!ctx.skipBoot && ctx.zone.status !== 'running') {
    const bootTask = await createTask({
      zone_name: ctx.zoneName,
      operation: 'start',
      depends_on: prev,
      parent_task_id: ctx.parentTaskId,
      created_by: ctx.createdBy,
    });
    ctx.taskChain.push({ step: 'boot', task_id: bootTask.id });
    prev = bootTask.id;
  }

  let shouldRunSetup = ctx.recipeId && !ctx.skipRecipe;
  if (shouldRunSetup) {
    const skipDueToSSH = await shouldSkipZoneSetup(ctx.zone, ctx.zoneIP, {
      credentials: ctx.credentials,
      ssh_port: ctx.provisioning.ssh_port,
    });
    if (skipDueToSSH) {
      shouldRunSetup = false;
    }
  }

  if (shouldRunSetup) {
    const setupTask = await createTask({
      zone_name: ctx.zoneName,
      operation: 'zone_setup',
      metadata: {
        recipe_id: ctx.recipeId,
        variables: {
          ...(ctx.provisioning.variables || {}),
          username: ctx.credentials.username,
          password: ctx.credentials.password,
        },
      },
      depends_on: prev,
      parent_task_id: ctx.parentTaskId,
      created_by: ctx.createdBy,
    });
    ctx.taskChain.push({ step: 'setup', task_id: setupTask.id });
    prev = setupTask.id;
  }

  return prev;
};

/**
 * folders[] sync — the run's OUTER opening bracket (document structure).
 * Anchor + one zone_sync per folder, LIST ORDER, only the document's own
 * flags (disabled/type) filtering. rsync/scp need ssh — winrm guests skip
 * LOUDLY (§5 matrix).
 * @param {Object} ctx - Chain context
 * @param {Array} folders - Folders in document order
 * @param {string|null} previousTaskId - Outer-chain dependency
 * @returns {Promise<string|null>} The last sync child's id
 */
export const queueSyncBracket = async (ctx, folders, previousTaskId) => {
  if (folders.length === 0) {
    return previousTaskId;
  }
  if (ctx.communicator === 'winrm') {
    log.task.warn('Folder sync skipped — rsync/scp need ssh, guest is winrm', {
      zone_name: ctx.zoneName,
      folders: folders.length,
    });
    ctx.taskChain.push({ step: 'sync_skipped_winrm', folder_count: folders.length });
    return previousTaskId;
  }
  const syncParentTask = await createTask({
    zone_name: ctx.zoneName,
    operation: 'zone_sync_parent',
    metadata: { total_folders: folders.length },
    parent: true,
    parent_task_id: ctx.parentTaskId,
    created_by: ctx.createdBy,
  });
  ctx.taskChain.push({
    step: 'sync_parent',
    task_id: syncParentTask.id,
    folder_count: folders.length,
  });

  return createSequentialTransferTasks('zone_sync', folders, {
    zoneName: ctx.zoneName,
    zoneIP: ctx.zoneIP,
    credentials: ctx.credentials,
    provisioning: ctx.provisioning,
    parentTaskId: syncParentTask.id,
    firstDependsOn: previousTaskId,
    createdBy: ctx.createdBy,
  });
};

/**
 * folders[] syncback — the run's OUTER closing bracket: flagged folders
 * (the document's own syncback flag) pull back guest → host, LIST ORDER.
 * @param {Object} ctx - Chain context
 * @param {Array} folders - All folders (the document's flags filter here)
 * @param {string|null} previousTaskId - Outer-chain dependency
 * @returns {Promise<string|null>} The last syncback child's id
 */
export const queueSyncbackBracket = async (ctx, folders, previousTaskId) => {
  const syncbackFolders = syncbackEligibleFolders(folders);
  if (syncbackFolders.length === 0) {
    return previousTaskId;
  }
  if (ctx.communicator === 'winrm') {
    log.task.warn('Syncback skipped — rsync/scp need ssh, guest is winrm', {
      zone_name: ctx.zoneName,
    });
    ctx.taskChain.push({ step: 'syncback_skipped_winrm', folder_count: syncbackFolders.length });
    return previousTaskId;
  }
  const syncbackParentTask = await createTask({
    zone_name: ctx.zoneName,
    operation: 'zone_syncback_parent',
    metadata: { total_folders: syncbackFolders.length },
    parent: true,
    parent_task_id: ctx.parentTaskId,
    created_by: ctx.createdBy,
  });
  ctx.taskChain.push({
    step: 'syncback_parent',
    task_id: syncbackParentTask.id,
    folder_count: syncbackFolders.length,
  });

  return createSequentialTransferTasks('zone_syncback', syncbackFolders, {
    zoneName: ctx.zoneName,
    zoneIP: ctx.zoneIP,
    credentials: ctx.credentials,
    provisioning: ctx.provisioning,
    parentTaskId: syncbackParentTask.id,
    firstDependsOn: previousTaskId,
    createdBy: ctx.createdBy,
  });
};
