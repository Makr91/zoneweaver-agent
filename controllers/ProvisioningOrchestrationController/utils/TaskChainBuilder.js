/**
 * @fileoverview Task chain builder for provisioning orchestration
 * @description THE DOCUMENT IS THE PROGRAM (Mark's no-phases ruling, binding
 * both agents): the run executes the stored document's `provisioning:`
 * section AS WRITTEN — methods in the order their KEYS APPEAR, entries
 * within each method in LIST ORDER, one chain, no agent-imposed phases or
 * grouping. `pre[]` runs before the FIRST method, `post[]` after the LAST
 * (B10). folders[] sync/syncback bracket the whole run OUTSIDE the hooks
 * (Q4 ruling: sync → pre → methods → post → syncback). Ansible groups walk
 * in list order, each group's local[] then remote[] per its own lists; the
 * provisioned-state stamp rides the run's overall LAST playbook. Unknown
 * method keys SURVIVE in the document and are narrated as unexecutable —
 * never edited away. Windows guests (settings.vagrant_communicator: winrm)
 * skip the ssh-only steps LOUDLY (§5 matrix: folders, ansible-local,
 * docker).
 */

import { log } from '../../../lib/Logger.js';
import {
  extractOrderedPlaybooks,
  extractFolders,
  extractShellScripts,
  extractDockerComposeFiles,
  extractHooks,
  buildScriptEnv,
  readsTrue,
} from '../../../lib/ProvisionerConfigBuilder.js';
import {
  createTask,
  createSequentialTransferTasks,
  syncbackEligibleFolders,
  shouldSkipZoneSetup,
  filterPlaybooksByRun,
  filterHooksByRun,
  hasZoneProvisionedBefore,
} from './TaskCreationHelper.js';
import { winrmDefaults } from '../../TaskManager/ZoneEngineManager.js';
import { parseConfiguration } from '../../../lib/ZoneConfigUtils.js';

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
 * folders[] sync — the run's OUTER opening bracket (document structure).
 * Anchor + one zone_sync per folder, LIST ORDER, only the document's own
 * flags (disabled/type) filtering. rsync/scp need ssh — winrm guests skip
 * LOUDLY (§5 matrix).
 * @param {Object} ctx - Chain context
 * @param {Array} folders - Folders in document order
 * @param {string|null} previousTaskId - Outer-chain dependency
 * @returns {Promise<string|null>} The last sync child's id
 */
const queueSyncBracket = async (ctx, folders, previousTaskId) => {
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
const queueSyncbackBracket = async (ctx, folders, previousTaskId) => {
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

/**
 * COLLECT one hook phase's steps (§5 shape, list order, run-directive
 * filtered). Pure — no tasks are created here.
 * @param {Object} ctx - Walk context
 * @param {string} phase - 'pre' | 'post'
 * @returns {Array<Object>} Step descriptors
 */
const collectHookSteps = (ctx, phase) => {
  const { included: hooks, skipped } = filterHooksByRun(
    extractHooks(ctx.provisioning, phase),
    ctx.provisionedBefore
  );
  if (skipped.length > 0) {
    log.task.info('Sequence hooks skipped by run directive', {
      zone_name: ctx.zoneName,
      phase,
      skipped,
    });
  }
  return hooks.map(hook => ({
    operation: 'zone_hook',
    metadata: {
      hook,
      phase,
      ip: ctx.zoneIP,
      port: ctx.provisioning.ssh_port || 22,
      credentials: ctx.credentials,
      env: ctx.env,
      communicator: ctx.communicator,
      winrm: ctx.winrm,
    },
    note: { step: `${phase}_hook`, script: hook.script, target: hook.target },
  }));
};

/**
 * COLLECT the shell method's steps — one zone_shell per script string,
 * list order. Pure.
 * @param {Object} ctx - Walk context
 * @param {Object} shell - The document's shell block
 * @returns {Array<Object>} Step descriptors
 */
const collectShellSteps = (ctx, shell) => {
  const scripts = extractShellScripts(shell);
  if (scripts === null) {
    return [];
  }
  return scripts.map(script => ({
    operation: 'zone_shell',
    metadata: {
      ip: ctx.zoneIP,
      port: ctx.provisioning.ssh_port || 22,
      credentials: ctx.credentials,
      script,
      env: ctx.env,
      communicator: ctx.communicator,
      winrm: ctx.winrm,
    },
    note: { step: 'shell', script },
  }));
};

/**
 * COLLECT the ansible method's steps — the document's playbooks groups in
 * LIST ORDER, each group's local[] then remote[] per its own lists, one
 * chain, each child's op per its OWN entry, run-directive filtered. On
 * winrm guests, LOCAL entries skip loudly (§5 matrix). Pure.
 * @param {Object} ctx - Walk context
 * @returns {Array<Object>} Step descriptors
 */
const collectAnsibleSteps = ctx => {
  const ordered = extractOrderedPlaybooks(ctx.provisioning);
  const { included, skipped } = filterPlaybooksByRun(ordered, ctx.provisionedBefore);
  if (skipped.length > 0) {
    log.task.info('Playbooks skipped by run directive', {
      zone_name: ctx.zoneName,
      skipped,
    });
  }
  let entries = included;
  if (ctx.communicator === 'winrm') {
    const locals = entries.filter(entry => entry.mode !== 'remote').length;
    if (locals > 0) {
      log.task.warn('ansible-local entries skipped — need ssh, guest is winrm (§5 matrix)', {
        zone_name: ctx.zoneName,
        skipped_local: locals,
      });
      ctx.taskChain.push({ step: 'ansible_local_skipped_winrm', playbook_count: locals });
      entries = entries.filter(entry => entry.mode === 'remote');
    }
  }
  return entries.map(playbook => {
    const remote = playbook.mode === 'remote';
    return {
      operation: remote ? 'zone_provision_remote' : 'zone_provision',
      metadata: {
        ip: ctx.zoneIP,
        port: ctx.provisioning.ssh_port || 22,
        credentials: ctx.credentials,
        playbook,
        communicator: ctx.communicator,
        winrm: ctx.winrm,
      },
      note: { step: remote ? 'provision_remote' : 'provision', playbook: playbook.playbook },
    };
  });
};

/**
 * COLLECT the docker method's steps — one zone_docker_compose per compose
 * file, list order (the document's shape: files nest INSIDE docker). No
 * engine install, no run pin; a guest without docker fails the task
 * honestly. ssh-only — winrm skips. Pure.
 * @param {Object} ctx - Walk context
 * @param {Object} docker - The document's docker block
 * @returns {Array<Object>} Step descriptors
 */
const collectDockerSteps = (ctx, docker) => {
  const files = extractDockerComposeFiles(docker);
  if (files === null) {
    return [];
  }
  if (ctx.communicator === 'winrm') {
    log.task.warn('docker skipped — executed over ssh, guest is winrm', {
      zone_name: ctx.zoneName,
    });
    ctx.taskChain.push({ step: 'docker_skipped_winrm' });
    return [];
  }
  return files.map(file => ({
    operation: 'zone_docker_compose',
    metadata: {
      ip: ctx.zoneIP,
      port: ctx.provisioning.ssh_port || 22,
      credentials: ctx.credentials,
      file,
    },
    note: { step: 'docker_compose', file },
  }));
};

/**
 * COLLECT one method key's steps (pure dispatch). Unknown method keys
 * survive in the document and are narrated as unexecutable — the document
 * is the PROGRAM, the agent never edits it.
 * @param {Object} ctx - Walk context
 * @param {string} key - Method key as it appears in the document
 * @param {*} value - The method block
 * @param {{sawAnsible: boolean}} state - Walk state
 * @returns {Array<Object>} Step descriptors
 */
const collectMethodSteps = (ctx, key, value, state) => {
  if (key === 'shell') {
    return collectShellSteps(ctx, value);
  }
  if (key === 'ansible') {
    state.sawAnsible = true;
    return readsTrue(value?.enabled) ? collectAnsibleSteps(ctx) : [];
  }
  if (key === 'docker') {
    return collectDockerSteps(ctx, value);
  }
  log.task.warn('provisioning method not executable by this agent — left as written', {
    zone_name: ctx.zoneName,
    method: key,
  });
  ctx.taskChain.push({ step: 'method_not_executable', method: key });
  return [];
};

/**
 * COLLECT the whole walk: pre[] before the first method, the
 * `provisioning:` section's method keys IN THE ORDER THEY APPEAR, post[]
 * after the last. The legacy flat `provisioners[]` tolerance fires only
 * when the section never declared ansible. The LAST step of the walk
 * carries `final: true` — the provisioned-state stamp marks completion of
 * the ENTIRE walk, whatever type its last entry is (Mark's whole-walk
 * stamp ruling).
 * @param {Object} ctx - Walk context
 * @returns {Array<Object>} Step descriptors, document order
 */
const collectWalkSteps = ctx => {
  const section = ctx.provisioning?.provisioning;
  const steps = [...collectHookSteps(ctx, 'pre')];

  const state = { sawAnsible: false };
  if (section && typeof section === 'object' && !Array.isArray(section)) {
    for (const [key, value] of Object.entries(section)) {
      if (key !== 'pre' && key !== 'post') {
        steps.push(...collectMethodSteps(ctx, key, value, state));
      }
    }
  }
  if (!state.sawAnsible && Array.isArray(ctx.provisioning?.provisioners)) {
    steps.push(...collectAnsibleSteps(ctx));
  }
  steps.push(...collectHookSteps(ctx, 'post'));

  if (steps.length > 0) {
    steps[steps.length - 1].metadata.final = true;
  }
  return steps;
};

/**
 * THE DOCUMENT WALK — collect the steps (pure, document order), then
 * create the task chain: every step a direct child of the run's parent
 * anchor (no method anchors — the no-phases ruling), each depending on
 * the previous.
 * @param {Object} ctx - Walk context ({zoneName, zoneIP, credentials,
 *   provisioning, env, communicator, winrm, provisionedBefore,
 *   parentTaskId, createdBy, taskChain})
 * @param {string|null} firstDependsOn - Outer-chain dependency
 * @returns {Promise<string|null>} The walk's last task id
 */
export const buildProvisioningWalk = (ctx, firstDependsOn) =>
  collectWalkSteps(ctx).reduce(
    (promise, step) =>
      promise.then(prevTaskId =>
        createTask({
          zone_name: ctx.zoneName,
          operation: step.operation,
          metadata: step.metadata,
          depends_on: prevTaskId,
          parent_task_id: ctx.parentTaskId,
          created_by: ctx.createdBy,
        }).then(task => {
          ctx.taskChain.push({ ...step.note, task_id: task.id });
          return task.id;
        })
      ),
    Promise.resolve(firstDependsOn)
  );

/**
 * The four RULED communicator alias pairs (Mark specifically approved this
 * dual naming — an explicit exception to the no-compat rule; nobody adds
 * more): new spelling ≡ vagrant_* spelling, the NEW one wins when both are
 * present (the shadowed key is narrated, never silent). Scope is exactly
 * these four keys.
 */
const COMMUNICATOR_ALIASES = [
  ['communicator', 'vagrant_communicator'],
  ['winrm_port', 'vagrant_winrm_port'],
  ['winrm_transport', 'vagrant_winrm_transport'],
  ['winrm_ssl_peer_verification', 'vagrant_winrm_ssl_peer_verification'],
];

/**
 * Resolve the document's communicator settings through the ruled alias
 * pairs. Documents ride verbatim — this resolves at READ time only.
 * @param {Object} settings - The document's settings section
 * @returns {{communicator: string, winrm: Object, shadowed: string[]}}
 */
export const resolveCommunicatorSettings = (settings = {}) => {
  const resolved = {};
  const shadowed = [];
  for (const [newKey, oldKey] of COMMUNICATOR_ALIASES) {
    if (settings[newKey] !== undefined && settings[oldKey] !== undefined) {
      shadowed.push(oldKey);
    }
    resolved[newKey] = settings[newKey] !== undefined ? settings[newKey] : settings[oldKey];
  }
  return {
    communicator: resolved.communicator === 'winrm' ? 'winrm' : 'ssh',
    // The Q2 defaults live in ONE place — the engine's winrmDefaults.
    winrm: winrmDefaults({
      port: resolved.winrm_port,
      transport: resolved.winrm_transport,
      ssl_peer_verification: resolved.winrm_ssl_peer_verification,
    }),
    shadowed,
  };
};

/**
 * Walk-context inputs read from the STORED DOCUMENT (Q2 ruling — the old
 * vocabulary IS the vocabulary, plus the four ruled aliases):
 * settings.communicator/vagrant_communicator selects the transport;
 * (vagrant_)winrm_* carry vagrant's own defaults. Document vars become the
 * script/hook env.
 * @param {Object} ctx - Chain context (mutated)
 * @param {Object} zoneConfig - Parsed zone configuration
 */
export const applyWalkSettings = (ctx, zoneConfig) => {
  const settings = zoneConfig?.settings || {};
  const { communicator, winrm, shadowed } = resolveCommunicatorSettings(settings);
  ctx.communicator = communicator;
  ctx.winrm = winrm;
  if (shadowed.length > 0) {
    log.task.warn('communicator keys shadowed — both spellings present, the new one wins', {
      zone_name: ctx.zoneName,
      shadowed,
    });
    ctx.taskChain?.push({ step: 'communicator_keys_shadowed', keys: shadowed });
  }
  ctx.env = buildScriptEnv(ctx.provisioning);
  ctx.provisionedBefore = hasZoneProvisionedBefore(ctx.zone);
};

/**
 * Build the provisioning task chain: infra (content → boot/setup → wait) →
 * folders sync (outer bracket) → THE DOCUMENT WALK (pre → methods in key
 * order → post) → folders syncback (outer close). Q4 nesting as ruled.
 * @param {Object} params - Parameters
 * @returns {Promise<Array>} Task chain
 */
export const buildProvisioningTaskChain = async params => {
  const ctx = { ...params, taskChain: [] };

  const zoneConfig = parseConfiguration(ctx.zone);
  const zoneDataset = zoneConfig.zonepath
    ? zoneConfig.zonepath.replace('/path', '')
    : `/rpool/zones/${ctx.zoneName}`;
  const cleanZoneDataset = zoneDataset.startsWith('/') ? zoneDataset.substring(1) : zoneDataset;
  const provisioningDatasetPath = `/${cleanZoneDataset}/provisioning`;

  applyWalkSettings(ctx, zoneConfig);

  let previousTaskId = await queueContentStep(ctx, zoneConfig, provisioningDatasetPath);
  previousTaskId = await queueBootAndSetupSteps(ctx, previousTaskId);

  // Wait for the guest (ssh, or win_ping over winrm)
  const sshTask = await createTask({
    zone_name: ctx.zoneName,
    operation: 'zone_wait_ssh',
    metadata: {
      ip: ctx.zoneIP,
      port: ctx.provisioning.ssh_port || 22,
      credentials: ctx.credentials,
      communicator: ctx.communicator,
      winrm: ctx.winrm,
    },
    depends_on: previousTaskId,
    parent_task_id: ctx.parentTaskId,
    created_by: ctx.createdBy,
  });
  ctx.taskChain.push({ step: 'wait_ssh', task_id: sshTask.id });
  previousTaskId = sshTask.id;

  const folders = extractFolders(ctx.provisioning);
  previousTaskId = await queueSyncBracket(ctx, folders, previousTaskId);
  previousTaskId = await buildProvisioningWalk(ctx, previousTaskId);
  previousTaskId = await queueSyncbackBracket(ctx, folders, previousTaskId);

  // Post-walk SSH key rotation (converged design, Mark-consumed): gated on
  // the DOCUMENT'S OWN vagrant_ssh_insert_key === true, ONE child after the
  // syncback bracket. It never owns `final` — the whole-walk stamp already
  // rides the walk's last step, and a rotation failure must not unmark a
  // completed run.
  if (zoneConfig.settings?.vagrant_ssh_insert_key === true) {
    if (ctx.communicator === 'winrm') {
      log.task.warn('Key rotation skipped — no ssh key semantics on a winrm guest', {
        zone_name: ctx.zoneName,
      });
      ctx.taskChain.push({ step: 'key_rotate_skipped_winrm' });
    } else {
      const rotateTask = await createTask({
        zone_name: ctx.zoneName,
        operation: 'zone_key_rotate',
        metadata: {
          ip: ctx.zoneIP,
          port: ctx.provisioning.ssh_port || 22,
          credentials: ctx.credentials,
          communicator: ctx.communicator,
        },
        depends_on: previousTaskId,
        parent_task_id: ctx.parentTaskId,
        created_by: ctx.createdBy,
      });
      ctx.taskChain.push({ step: 'key_rotate', task_id: rotateTask.id });
    }
  }

  return ctx.taskChain;
};
