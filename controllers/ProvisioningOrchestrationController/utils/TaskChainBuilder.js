/**
 * @fileoverview Task chain builder for provisioning orchestration
 */

import { log } from '../../../lib/Logger.js';
import {
  extractPlaybooks,
  extractFolders,
  extractShellScripts,
} from '../../../lib/ProvisionerConfigBuilder.js';
import {
  createTask,
  createSequentialFolderTasks,
  createSequentialPlaybookTasks,
  createSequentialShellTasks,
  createSequentialSyncbackTasks,
  syncbackEligibleFolders,
  shouldSkipZoneSetup,
  filterPlaybooksByRun,
  hasZoneProvisionedBefore,
} from './TaskCreationHelper.js';

/**
 * Step 0: land the provisioning content — uploaded artifact, or the
 * referenced registry package (create-from-package zones).
 * @param {Object} ctx - Chain context
 * @param {Object} zoneConfig - Parsed zone configuration
 * @param {string} provisioningDatasetPath - Provisioning dataset mountpoint
 * @returns {Promise<string|null>} The step's task id (null when no content step)
 */
const queueContentStep = async (ctx, zoneConfig, provisioningDatasetPath) => {
  if (ctx.artifactId) {
    const extractTask = await createTask({
      zone_name: ctx.zoneName,
      operation: 'zone_provisioning_extract',
      metadata: {
        artifact_id: ctx.artifactId,
        dataset_path: provisioningDatasetPath,
      },
      depends_on: null,
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
      depends_on: null,
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
const queueBootAndSetupSteps = async (ctx, previousTaskId) => {
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
 * Step 4: the sync phase — anchor + one zone_sync per folder. The parent is a
 * pure anchor (born running, never dispatched): its children drive its
 * completion, so they chain off the OUTER previous task and the next step
 * gates on the LAST sync child.
 * @param {Object} ctx - Chain context
 * @param {Array} folders - Folders to sync
 * @param {string|null} previousTaskId - Outer-chain dependency
 * @returns {Promise<string|null>} The last sync child's id
 */
const queueSyncPhase = async (ctx, folders, previousTaskId) => {
  if (folders.length === 0) {
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

  return createSequentialFolderTasks(
    folders,
    ctx.zoneName,
    ctx.zoneIP,
    ctx.credentials,
    ctx.provisioning,
    syncParentTask.id,
    previousTaskId,
    ctx.createdBy
  );
};

/**
 * Step 5: the shell phase — anchor + one zone_shell per script
 * (provisioning.shell, Hosts.rb order: after sync, before provision — scripts
 * carry no run directive and run every provision), same anchor rule as sync.
 * @param {Object} ctx - Chain context
 * @param {string|null} previousTaskId - Outer-chain dependency
 * @returns {Promise<string|null>} The last shell child's id
 */
const queueShellPhase = async (ctx, previousTaskId) => {
  const scripts = extractShellScripts(ctx.provisioning);
  if (scripts.length === 0) {
    return previousTaskId;
  }
  const shellParentTask = await createTask({
    zone_name: ctx.zoneName,
    operation: 'zone_shell_parent',
    metadata: { total_scripts: scripts.length },
    parent: true,
    parent_task_id: ctx.parentTaskId,
    created_by: ctx.createdBy,
  });
  ctx.taskChain.push({
    step: 'shell_parent',
    task_id: shellParentTask.id,
    script_count: scripts.length,
  });

  return createSequentialShellTasks(
    scripts,
    ctx.zoneName,
    ctx.zoneIP,
    ctx.credentials,
    ctx.provisioning,
    shellParentTask.id,
    previousTaskId,
    ctx.createdBy
  );
};

/**
 * Step 6: the provision phase — anchor + one zone_provision per playbook
 * (run-directive filtered), same anchor rule as sync.
 * @param {Object} ctx - Chain context
 * @param {string|null} previousTaskId - Outer-chain dependency
 * @returns {Promise<string|null>} The last provision child's id
 */
const queueProvisionPhase = async (ctx, previousTaskId) => {
  const configuredPlaybooks = extractPlaybooks(ctx.provisioning);
  const { included: playbooks, skipped: skippedPlaybooks } = filterPlaybooksByRun(
    configuredPlaybooks,
    hasZoneProvisionedBefore(ctx.zone)
  );

  if (skippedPlaybooks.length > 0) {
    log.task.info('Playbooks skipped by run directive', {
      zone_name: ctx.zoneName,
      skipped: skippedPlaybooks,
    });
  }
  if (playbooks.length === 0) {
    return previousTaskId;
  }

  const provisionParentTask = await createTask({
    zone_name: ctx.zoneName,
    operation: 'zone_provision_parent',
    metadata: { total_playbooks: playbooks.length, skipped_playbooks: skippedPlaybooks },
    parent: true,
    parent_task_id: ctx.parentTaskId,
    created_by: ctx.createdBy,
  });
  ctx.taskChain.push({
    step: 'provision_parent',
    task_id: provisionParentTask.id,
    playbook_count: playbooks.length,
    playbooks_skipped: skippedPlaybooks,
  });

  return createSequentialPlaybookTasks(
    playbooks,
    ctx.zoneName,
    ctx.zoneIP,
    ctx.credentials,
    ctx.provisioning,
    provisionParentTask.id,
    previousTaskId,
    ctx.createdBy
  );
};

/**
 * Step 7: the syncback phase AFTER provision (Go's machine_syncback shape) —
 * flagged folders pull back guest → host, gated on the LAST playbook child.
 * @param {Object} ctx - Chain context
 * @param {Array} folders - All folders (eligibility filtered here)
 * @param {string|null} previousTaskId - Outer-chain dependency
 */
const queueSyncbackPhase = async (ctx, folders, previousTaskId) => {
  const syncbackFolders = syncbackEligibleFolders(folders);
  if (syncbackFolders.length === 0) {
    return;
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

  await createSequentialSyncbackTasks(
    syncbackFolders,
    ctx.zoneName,
    ctx.zoneIP,
    ctx.credentials,
    ctx.provisioning,
    syncbackParentTask.id,
    previousTaskId,
    ctx.createdBy
  );
};

/**
 * Build provisioning task chain with granular folder/playbook tasks
 * Creates parent tasks for sync and provision steps with individual child tasks
 * @param {Object} params - Parameters
 * @returns {Promise<Array>} Task chain
 */
export const buildProvisioningTaskChain = async params => {
  const ctx = { ...params, taskChain: [] };

  let zoneConfig = ctx.zone.configuration || {};
  if (typeof zoneConfig === 'string') {
    try {
      zoneConfig = JSON.parse(zoneConfig);
    } catch (e) {
      log.api.warn('Failed to parse zone configuration', { error: e.message });
      zoneConfig = {};
    }
  }
  const zoneDataset = zoneConfig.zonepath
    ? zoneConfig.zonepath.replace('/path', '')
    : `/rpool/zones/${ctx.zoneName}`;
  const cleanZoneDataset = zoneDataset.startsWith('/') ? zoneDataset.substring(1) : zoneDataset;
  const provisioningDatasetPath = `/${cleanZoneDataset}/provisioning`;

  let previousTaskId = await queueContentStep(ctx, zoneConfig, provisioningDatasetPath);
  previousTaskId = await queueBootAndSetupSteps(ctx, previousTaskId);

  // Step 3: Wait for SSH
  const sshTask = await createTask({
    zone_name: ctx.zoneName,
    operation: 'zone_wait_ssh',
    metadata: {
      ip: ctx.zoneIP,
      port: ctx.provisioning.ssh_port || 22,
      credentials: ctx.credentials,
    },
    depends_on: previousTaskId,
    parent_task_id: ctx.parentTaskId,
    created_by: ctx.createdBy,
  });
  ctx.taskChain.push({ step: 'wait_ssh', task_id: sshTask.id });
  previousTaskId = sshTask.id;

  const folders = extractFolders(ctx.provisioning);
  previousTaskId = await queueSyncPhase(ctx, folders, previousTaskId);
  previousTaskId = await queueShellPhase(ctx, previousTaskId);
  previousTaskId = await queueProvisionPhase(ctx, previousTaskId);
  await queueSyncbackPhase(ctx, folders, previousTaskId);

  return ctx.taskChain;
};
