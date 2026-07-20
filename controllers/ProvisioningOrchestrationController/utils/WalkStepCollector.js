import { log } from '../../../lib/Logger.js';
import {
  extractOrderedPlaybooks,
  extractShellScripts,
  extractDockerComposeFiles,
  extractHooks,
  readsTrue,
} from '../../../lib/ProvisionerConfigBuilder.js';
import { filterPlaybooksByRun, filterHooksByRun } from './TaskCreationHelper.js';

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
export const collectWalkSteps = ctx => {
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
