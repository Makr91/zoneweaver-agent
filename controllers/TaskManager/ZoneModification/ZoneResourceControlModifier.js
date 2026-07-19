/**
 * @fileoverview Zone resource-control modifier (the surveyed zonecfg families, exposed 2026-07-19)
 * @description capped-cpu / capped-memory / dedicated-cpu / rctl /
 * security-flags / admin / fs-allowed through zonecfg's offline store.
 * Replace semantics: an object value REPLACES the whole resource (a
 * tolerated remove first, then the add — presence never guessed from zadm's
 * JSON rendering); an explicit null REMOVES it; absent keys touch nothing.
 * Changes land at the next zone boot like every other modify.
 */

import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import { updateTaskProgress } from '../../../lib/TaskProgressHelper.js';

const zonecfg = (zoneName, body, onData) =>
  executeCommand(`pfexec zonecfg -z ${zoneName} "${body}"`, undefined, onData);

const toleratedRemove = async (zoneName, body, onData) => {
  const result = await zonecfg(zoneName, body, onData);
  if (!result.success) {
    onData?.({ stream: 'stdout', data: `zonecfg ${body} — nothing to remove\n` });
  }
};

const collectCappedCpu = (metadata, plan) => {
  if (metadata.capped_cpu === undefined) {
    return;
  }
  plan.removes.push('remove -F capped-cpu;');
  if (metadata.capped_cpu !== null) {
    plan.strict.push(`add capped-cpu; set ncpus=${metadata.capped_cpu.ncpus}; end;`);
  }
  plan.changes.push('capped_cpu');
};

const collectCappedMemory = (metadata, plan) => {
  if (metadata.capped_memory === undefined) {
    return;
  }
  plan.removes.push('remove -F capped-memory;');
  if (metadata.capped_memory !== null) {
    const sets = ['physical', 'swap', 'locked']
      .filter(key => metadata.capped_memory[key] !== undefined)
      .map(key => `set ${key}=${metadata.capped_memory[key]};`)
      .join(' ');
    plan.strict.push(`add capped-memory; ${sets} end;`);
  }
  plan.changes.push('capped_memory');
};

const collectDedicatedCpu = (metadata, plan) => {
  if (metadata.dedicated_cpu === undefined) {
    return;
  }
  plan.removes.push('remove -F dedicated-cpu;');
  if (metadata.dedicated_cpu !== null) {
    const importance =
      metadata.dedicated_cpu.importance !== undefined
        ? ` set importance=${metadata.dedicated_cpu.importance};`
        : '';
    plan.strict.push(
      `add dedicated-cpu; set ncpus=${metadata.dedicated_cpu.ncpus};${importance} end;`
    );
  }
  plan.changes.push('dedicated_cpu');
};

const collectSecurityFlags = (metadata, plan) => {
  if (metadata.security_flags === undefined) {
    return;
  }
  plan.removes.push('remove -F security-flags;');
  if (metadata.security_flags !== null) {
    const sets = ['default', 'lower', 'upper']
      .filter(key => metadata.security_flags[key] !== undefined)
      .map(key => `set ${key}=${metadata.security_flags[key]};`)
      .join(' ');
    plan.strict.push(`add security-flags; ${sets} end;`);
  }
  plan.changes.push('security_flags');
};

const collectRctls = (metadata, plan) => {
  for (const name of Array.isArray(metadata.remove_rctls) ? metadata.remove_rctls : []) {
    plan.removes.push(`remove rctl name=${name};`);
    plan.changes.push('rctls');
  }
  for (const rctl of Array.isArray(metadata.rctls) ? metadata.rctls : []) {
    if (!rctl?.name || rctl.limit === undefined) {
      throw new Error('rctls entries need name and limit');
    }
    const priv = rctl.priv || 'privileged';
    const action = rctl.action || 'deny';
    plan.removes.push(`remove rctl name=${rctl.name};`);
    plan.strict.push(
      `add rctl; set name=${rctl.name}; add value (priv=${priv},limit=${rctl.limit},action=${action}); end;`
    );
    plan.changes.push('rctls');
  }
};

const collectAdmins = (metadata, plan) => {
  for (const user of Array.isArray(metadata.remove_admins) ? metadata.remove_admins : []) {
    plan.removes.push(`remove admin user=${user};`);
    plan.changes.push('admins');
  }
  for (const admin of Array.isArray(metadata.admins) ? metadata.admins : []) {
    if (!admin?.user || !admin?.auths) {
      throw new Error('admins entries need user and auths');
    }
    plan.removes.push(`remove admin user=${admin.user};`);
    plan.strict.push(`add admin; set user=${admin.user}; set auths=${admin.auths}; end;`);
    plan.changes.push('admins');
  }
};

const existingNumberedAttrs = (zoneConfig, prefix) => {
  const names = new Set();
  const pattern = new RegExp(`^${prefix}\\d+$`, 'u');
  for (const attr of Array.isArray(zoneConfig?.attr) ? zoneConfig.attr : []) {
    if (attr?.name && pattern.test(attr.name)) {
      names.add(attr.name);
    }
  }
  const topLevel = zoneConfig?.[prefix];
  for (let i = 0; i < (Array.isArray(topLevel) ? topLevel.length : 0); i++) {
    names.add(`${prefix}${i}`);
  }
  return [...names];
};

const collectVirtfs = (zoneConfig, metadata, plan) => {
  if (metadata.virtfs === undefined) {
    return;
  }
  for (const name of existingNumberedAttrs(zoneConfig, 'virtfs')) {
    plan.removes.push(`remove attr name=${name};`);
  }
  (Array.isArray(metadata.virtfs) ? metadata.virtfs : []).forEach((share, index) => {
    if (!share?.name || !share?.path) {
      throw new Error('virtfs entries need name and path');
    }
    const value = `${share.name},${share.path}${share.ro === true ? ',ro' : ''}`;
    plan.strict.push(
      `add attr; set name=virtfs${index}; set type=string; set value=${value}; end;`
    );
  });
  plan.changes.push('virtfs');
};

const collectPpt = (zoneConfig, metadata, plan) => {
  if (metadata.ppt === undefined) {
    return;
  }
  for (const name of existingNumberedAttrs(zoneConfig, 'ppt')) {
    plan.removes.push(`remove attr name=${name};`);
    plan.removes.push(`remove device match=/dev/${name};`);
  }
  for (const entry of Array.isArray(metadata.ppt) ? metadata.ppt : []) {
    const leaf = String(entry?.device || '').replace(/^\/dev\//u, '');
    if (!/^ppt\d+$/u.test(leaf)) {
      throw new Error('ppt entries need device pptN (pptadm list -a names them)');
    }
    const state = entry.state || 'on';
    if (!/^(?:on|off|slot[0-7])$/u.test(state)) {
      throw new Error(`ppt state ${state} is not on|off|slot0-7`);
    }
    plan.strict.push(
      `add attr; set name=${leaf}; set type=string; set value=${state}; end; add device; set match=/dev/${leaf}; end;`
    );
  }
  plan.changes.push('ppt');
};

const collectFsAllowed = (metadata, plan) => {
  if (metadata.fs_allowed === undefined) {
    return;
  }
  if (metadata.fs_allowed === null || metadata.fs_allowed === '') {
    plan.removes.push('clear fs-allowed;');
  } else {
    plan.strict.push(`set fs-allowed=${metadata.fs_allowed};`);
  }
  plan.changes.push('fs_allowed');
};

/**
 * Apply the resource-control families named in the metadata. Tolerated
 * removes run first (one at a time — an absent resource is narrated, never
 * fatal); the adds/sets then run as ONE strict batch whose failure fails the
 * task honestly.
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Live zadm configuration (numbered-attr enumeration)
 * @param {Object} metadata - Modification metadata
 * @param {Object} task - Task object
 * @param {Array} changes - Changes array (mutated)
 * @param {Function|null} onData - Output sink
 * @returns {Promise<void>}
 */
export const applyResourceControlChanges = async (
  zoneName,
  zoneConfig,
  metadata,
  task,
  changes,
  onData = null
) => {
  const plan = { removes: [], strict: [], changes: [] };
  collectCappedCpu(metadata, plan);
  collectCappedMemory(metadata, plan);
  collectDedicatedCpu(metadata, plan);
  collectSecurityFlags(metadata, plan);
  collectRctls(metadata, plan);
  collectAdmins(metadata, plan);
  collectVirtfs(zoneConfig, metadata, plan);
  collectPpt(zoneConfig, metadata, plan);
  collectFsAllowed(metadata, plan);

  if (plan.changes.length === 0) {
    return;
  }
  await updateTaskProgress(task, 45, { status: 'modifying_resource_controls' });

  await plan.removes.reduce(
    (chain, removeCommand) => chain.then(() => toleratedRemove(zoneName, removeCommand, onData)),
    Promise.resolve()
  );
  if (plan.strict.length > 0) {
    const result = await zonecfg(zoneName, plan.strict.join(' '), onData);
    if (!result.success) {
      throw new Error(`Resource-control modification failed: ${result.error}`);
    }
  }
  changes.push(...new Set(plan.changes));
  log.task.info('Applied resource-control changes', {
    zone_name: zoneName,
    families: [...new Set(plan.changes)],
  });
};
