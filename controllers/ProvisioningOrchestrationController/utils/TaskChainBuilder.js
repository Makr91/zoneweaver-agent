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
import { extractFolders, buildScriptEnv } from '../../../lib/ProvisionerConfigBuilder.js';
import { createTask, hasZoneProvisionedBefore } from './TaskCreationHelper.js';
import {
  queueContentStep,
  queueBootAndSetupSteps,
  queueSyncBracket,
  queueSyncbackBracket,
} from './ChainInfraSteps.js';
import { collectWalkSteps } from './WalkStepCollector.js';
import { winrmDefaults } from '../../TaskManager/ZoneEngineManager.js';
import { getRootPool } from '../../../lib/DiskSpec.js';
import { parseConfiguration } from '../../../lib/ZoneConfigUtils.js';
import { effectiveRemoveOnCompletion } from '../../../lib/ProvisioningNetwork.js';

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
    : `/${await getRootPool()}/zones/${ctx.zoneName}`;
  const cleanZoneDataset = zoneDataset.startsWith('/') ? zoneDataset.substring(1) : zoneDataset;
  const provisioningDatasetPath = `/${cleanZoneDataset}/provisioning`;

  applyWalkSettings(ctx, zoneConfig);

  let previousTaskId =
    (await queueContentStep(ctx, zoneConfig, provisioningDatasetPath)) ??
    ctx.firstDependsOn ??
    null;
  previousTaskId = await queueBootAndSetupSteps(ctx, previousTaskId);

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

  const provisionalEntry = Array.isArray(zoneConfig.networks)
    ? zoneConfig.networks.find(net => net?.provisional === true)
    : null;
  if (provisionalEntry && effectiveRemoveOnCompletion(provisionalEntry)) {
    const removeTask = await createTask({
      zone_name: ctx.zoneName,
      operation: 'zone_transport_remove',
      depends_on: previousTaskId,
      parent_task_id: ctx.parentTaskId,
      created_by: ctx.createdBy,
    });
    ctx.taskChain.push({ step: 'transport_remove', task_id: removeTask.id });
    const stopTask = await createTask({
      zone_name: ctx.zoneName,
      operation: 'stop',
      depends_on: removeTask.id,
      parent_task_id: ctx.parentTaskId,
      created_by: ctx.createdBy,
    });
    ctx.taskChain.push({ step: 'post_removal_stop', task_id: stopTask.id });
    const startTask = await createTask({
      zone_name: ctx.zoneName,
      operation: 'start',
      depends_on: stopTask.id,
      parent_task_id: ctx.parentTaskId,
      created_by: ctx.createdBy,
    });
    ctx.taskChain.push({ step: 'post_removal_boot', task_id: startTask.id });
  }

  return ctx.taskChain;
};
