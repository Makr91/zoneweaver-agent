/**
 * @fileoverview Parity-engine task executors (provisioning-design §5)
 * @description The engine task executors beyond sync/shell/ansible-local: ansible
 * REMOTE (runs on the agent host over the guest transport), docker_compose execution
 * in the guest, post-walk SSH key rotation, provisioning-transport removal, and
 * sequence hooks (pre/post, host|guest targets). The shared winrm/env/stamp/path
 * helpers live in ZoneEngineManager (one-way dependency).
 */

import fs from 'fs';
import path from 'path';
import { executeCommand } from '../../lib/CommandManager.js';
import { executeSSHCommand, resolveRelativeKeyPath } from '../../lib/SSHManager.js';
import { updateTaskProgress, parseTaskMetadata } from '../../lib/TaskProgressHelper.js';
import {
  parseConfiguration,
  provisioningPathFromZonepath,
  getZoneConfig,
} from '../../lib/ZoneConfigUtils.js';
import { removeDocumentNetworkEntry } from '../../lib/ZoneConfigMutators.js';
import { log } from '../../lib/Logger.js';
import Zones from '../../models/ZoneModel.js';
import config from '../../config/ConfigLoader.js';
import { shellQuote } from './ZoneEngine/ShellPrimitives.js';
import {
  buildRemoteEnvPrefix,
  installHostCollections,
  verboseFlag,
  prepareRemoteRun,
} from './ZoneEngine/RemoteRun.js';
import { runHookOnTarget } from './ZoneEngine/HookRunner.js';
import {
  getProvisioningBasePath,
  readDocumentControlIP,
  NO_CONTROL_IP_ERROR,
  recordProvisionState,
} from './ZoneEngineManager.js';

/**
 * Execute a REMOTE playbook (§5): ansible-playbook runs ON THE AGENT HOST
 * against the guest over its transport (ssh key or winrm). The playbook path
 * is package-relative on the HOST (the staged provisioning dataset); the
 * package's vendored collections resolve via ANSIBLE_COLLECTIONS_PATH, and
 * remote_collections galaxy-installs host-side.
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneProvisionRemoteTask = async task => {
  const { zone_name } = task;
  try {
    const metadata = await parseTaskMetadata(task);
    const { playbook, communicator = 'ssh', final = false } = metadata;
    const { onData } = task;
    if (!playbook?.playbook) {
      return { success: false, error: 'playbook is required in task metadata' };
    }
    // The chain may predate the provisioning lease — the document is the truth.
    const ip = metadata.ip || (await readDocumentControlIP(zone_name));
    if (!ip) {
      return { success: false, error: NO_CONTROL_IP_ERROR };
    }

    await updateTaskProgress(task, 10, { status: 'checking_host_ansible' });
    const prep = await prepareRemoteRun(zone_name, { ...metadata, ip, communicator });
    if (prep.error) {
      return { success: false, error: prep.error };
    }
    const { zone, provisioningBasePath, transport, playbookPath } = prep;

    const zoneConfig = parseConfiguration(zone);
    const { buildExtraVarsFromZone, buildPlaybookExtraVars } =
      await import('../../lib/ProvisionerConfigBuilder.js');
    const extraVars = buildPlaybookExtraVars(
      buildExtraVarsFromZone(zone, zoneConfig.provisioner || {}, { provisioningBasePath }),
      playbook
    );

    const envPrefix = buildRemoteEnvPrefix(playbook, provisioningBasePath);
    await updateTaskProgress(task, 25, { status: 'installing_collections' });
    const galaxyError = await installHostCollections(envPrefix, playbook, onData);
    if (galaxyError) {
      return { success: false, error: galaxyError };
    }

    const provConfig = config.get('provisioning') || {};
    const playbookTimeout = (provConfig.playbook_timeout_seconds || 21600) * 1000;
    const varsJson = JSON.stringify(extraVars).replace(/'/gu, "'\\''");

    await updateTaskProgress(task, 40, { status: 'running_playbook' });
    log.task.info('Running remote ansible playbook from the host', {
      zone_name,
      playbook: playbook.playbook,
      communicator,
    });
    const result = await executeCommand(
      `${envPrefix}ansible-playbook -i ${shellQuote(`${ip},`)} ${transport.args}${verboseFlag(playbook)} --extra-vars '${varsJson}' ${shellQuote(playbookPath)}`,
      playbookTimeout,
      onData
    );

    await Zones.update({ last_seen: new Date() }, { where: { name: zone_name } });
    if (!result.success) {
      return { success: false, error: `Ansible remote failed: ${result.error}` };
    }
    if (final) {
      await updateTaskProgress(task, 95, { status: 'recording_provision_state' });
      await recordProvisionState(zone_name);
    }
    return { success: true, message: `Remote playbook completed: ${playbook.playbook}` };
  } catch (error) {
    log.task.error('Remote provisioning failed', { zone_name, error: error.message });
    return { success: false, error: `Remote provisioning failed: ${error.message}` };
  }
};

/**
 * Execute ONE compose file — exactly what the document prescribed, nothing
 * else: `docker compose -f <file> up -d` in the guest (legacy docker-compose
 * binary as the fallback). No engine install (never ruled — a guest without
 * docker fails honestly), no run pin.
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneDockerComposeTask = async task => {
  const { zone_name } = task;
  try {
    const metadata = await parseTaskMetadata(task);
    const { port = 22, credentials = {}, file, final = false } = metadata;
    const { onData } = task;
    if (!file) {
      return { success: false, error: 'file is required in task metadata' };
    }
    // The chain may predate the provisioning lease — the document is the truth.
    const ip = metadata.ip || (await readDocumentControlIP(zone_name));
    if (!ip) {
      return { success: false, error: NO_CONTROL_IP_ERROR };
    }
    const provisioningBasePath = await getProvisioningBasePath(zone_name);
    const username = credentials.username || 'root';
    const provConfig = config.get('provisioning') || {};
    const timeout = (provConfig.docker_timeout_seconds || 3600) * 1000;

    await updateTaskProgress(task, 20, { status: 'running_compose', message: file });
    const result = await executeSSHCommand(
      ip,
      username,
      credentials,
      `sudo docker compose -f ${shellQuote(file)} up -d || sudo docker-compose -f ${shellQuote(file)} up -d`,
      port,
      { timeout, provisioningBasePath, onData }
    );
    if (!result.success) {
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n---STDERR---\n');
      return { success: false, error: `docker compose up failed for ${file}:\n${output}` };
    }
    // Whole-walk stamp ruling: `final` rides the run's LAST step.
    if (final) {
      await updateTaskProgress(task, 95, { status: 'recording_provision_state' });
      await recordProvisionState(zone_name);
    }
    return { success: true, message: `Compose file up: ${file}` };
  } catch (error) {
    log.task.error('Compose provisioning failed', { zone_name, error: error.message });
    return { success: false, error: `Compose provisioning failed: ${error.message}` };
  }
};

/**
 * Execute the post-walk SSH key rotation (op zone_key_rotate — the
 * converged design, Mark-consumed 2026-07-17): gated on the DOCUMENT'S OWN
 * settings.vagrant_ssh_insert_key === true, ONE child after the syncback
 * bracket, NEVER the stamp owner (a rotation failure must not unmark a
 * completed run). Hosts.rb's exact mechanics: fetch the guest's
 * /home/<user>/.ssh/id_ssh_rsa, land it at the working copy's
 * vagrant_user_private_key_path (0600 — tier 1 of the connect ruling stays
 * warm), then strip the bootstrap pubkey line from the guest file
 * (`sed -i '/vagrantup/d'`, Hosts.rb verbatim). winrm guests and missing
 * guest keys skip LOUDLY (a box built without rotation is not a failure).
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneKeyRotateTask = async task => {
  const { zone_name } = task;
  try {
    const metadata = await parseTaskMetadata(task);
    const { port = 22, credentials = {}, communicator = 'ssh' } = metadata;
    const { onData } = task;
    const username = credentials.username || 'root';

    if (communicator === 'winrm') {
      onData?.({
        stream: 'stdout',
        data: 'Key rotation skipped — no ssh key file semantics on a winrm guest\n',
      });
      return { success: true, message: 'Key rotation skipped (winrm guest)' };
    }
    // The chain may predate the provisioning lease — the document is the truth.
    const ip = metadata.ip || (await readDocumentControlIP(zone_name));
    if (!ip) {
      return { success: false, error: NO_CONTROL_IP_ERROR };
    }

    const zone = await Zones.findOne({ where: { name: zone_name } });
    const zoneConfig = parseConfiguration(zone);
    const keySetting = zoneConfig.settings?.vagrant_user_private_key_path;
    if (!keySetting) {
      onData?.({
        stream: 'stdout',
        data: 'Key rotation skipped — the document names no vagrant_user_private_key_path\n',
      });
      return { success: true, message: 'Key rotation skipped (no key path in document)' };
    }
    const provisioningBasePath = provisioningPathFromZonepath(zoneConfig.zonepath);
    const destPath = resolveRelativeKeyPath(keySetting, provisioningBasePath);

    await updateTaskProgress(task, 20, { status: 'fetching_guest_key' });
    const guestKeyFile = `/home/${username}/.ssh/id_ssh_rsa`;
    const fetched = await executeSSHCommand(
      ip,
      username,
      credentials,
      `cat ${guestKeyFile}`,
      port,
      { provisioningBasePath, onData: null }
    );
    if (!fetched.success || !fetched.stdout.includes('PRIVATE KEY')) {
      onData?.({
        stream: 'stdout',
        data: `Key rotation skipped — ${guestKeyFile} is absent on the guest (box built without rotation)\n`,
      });
      return { success: true, message: 'Key rotation skipped (no rotated key on guest)' };
    }

    await updateTaskProgress(task, 55, { status: 'landing_key' });
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, `${fetched.stdout.trim()}\n`, { mode: 0o600 });
    fs.chmodSync(destPath, 0o600);
    onData?.({ stream: 'stdout', data: `Rotated key landed at ${destPath}\n` });

    // Hosts.rb's exact strip — the bootstrap pubkey line dies on the guest.
    await updateTaskProgress(task, 80, { status: 'stripping_bootstrap_key' });
    const stripped = await executeSSHCommand(
      ip,
      username,
      credentials,
      `sed -i '/vagrantup/d' ${guestKeyFile}`,
      port,
      { provisioningBasePath, onData }
    );
    if (!stripped.success) {
      return {
        success: false,
        error: `bootstrap key strip failed on the guest: ${stripped.stderr || stripped.stdout}`,
      };
    }

    return { success: true, message: `SSH key rotated — tier-1 key warm at ${destPath}` };
  } catch (error) {
    log.task.error('Key rotation failed', { zone_name, error: error.message });
    return { success: false, error: `Key rotation failed: ${error.message}` };
  }
};

/**
 * Execute zone_transport_remove (Mark's execution ruling, 2026-07-18):
 * remove the provisional NIC from the zone config + the document entry
 * (is_control flips to the real NIC), narrated. The pipeline chains a
 * stop + start after this task; the post-removal boot gates on nothing.
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneTransportRemoveTask = async task => {
  const { zone_name } = task;
  try {
    const { onData } = task;
    const zone = await Zones.findOne({ where: { name: zone_name } });
    if (!zone) {
      return { success: false, error: `Zone '${zone_name}' not found` };
    }
    const { networks } = parseConfiguration(zone);
    const index = Array.isArray(networks)
      ? networks.findIndex(net => net?.provisional === true)
      : -1;
    if (index === -1) {
      return {
        success: true,
        message: 'No provisional entry in the document — nothing to remove',
      };
    }

    const liveConfig = await getZoneConfig(zone_name);
    const nets = Array.isArray(liveConfig?.net) ? liveConfig.net : [];
    const physical = nets[index]?.physical;
    if (physical) {
      const result = await executeCommand(
        `pfexec zonecfg -z ${zone_name} "remove net physical=${physical}"`
      );
      if (!result.success) {
        return {
          success: false,
          error: `Failed to remove transport NIC ${physical}: ${result.error}`,
        };
      }
      onData?.({
        stream: 'stdout',
        data: `Provisioning transport NIC ${physical} removed from the zone configuration\n`,
      });
    } else {
      onData?.({
        stream: 'stdout',
        data: 'No net resource pairs with the provisional entry — cleaning the document only\n',
      });
    }

    await removeDocumentNetworkEntry(zone_name, index);
    onData?.({
      stream: 'stdout',
      data: "Document entry removed; is_control rides the machine's real NIC now. The agent may lose direct reach after the power cycle — the run completes at boot, ungated.\n",
    });
    return { success: true, message: 'Provisioning transport removed — power cycle follows' };
  } catch (error) {
    log.task.error('Transport removal failed', { zone_name, error: error.message });
    return { success: false, error: `Transport removal failed: ${error.message}` };
  }
};

/**
 * Execute ONE sequence hook (§5): {script, target: host|guest, on_failure:
 * abort|continue, run} — pre[] before the first method, post[] after the
 * last (B10). on_failure: continue converts a failure into a LOUD success
 * so the chain proceeds (a failed task would cancel every dependent).
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneHookTask = async task => {
  const { zone_name } = task;
  try {
    const metadata = await parseTaskMetadata(task);
    const {
      hook,
      phase,
      port = 22,
      credentials = {},
      env = {},
      communicator = 'ssh',
      winrm,
      final = false,
    } = metadata;
    const { onData } = task;
    if (!hook?.script) {
      return { success: false, error: 'hook.script is required in task metadata' };
    }
    // Host-target hooks need no guest transport; guest targets read the
    // document when the chain predates the provisioning lease.
    let { ip } = metadata;
    if (hook.target !== 'host' && !ip) {
      ip = await readDocumentControlIP(zone_name);
      if (!ip) {
        return { success: false, error: NO_CONTROL_IP_ERROR };
      }
    }

    const provisioningBasePath = await getProvisioningBasePath(zone_name);
    if (!hook.script.startsWith('/') && !provisioningBasePath) {
      return { success: false, error: 'no provisioning dataset path to resolve the hook script' };
    }
    const resolvedScript = hook.script.startsWith('/')
      ? hook.script
      : `${provisioningBasePath}/${hook.script}`;
    if (!fs.existsSync(resolvedScript)) {
      return { success: false, error: `hook script not found: ${resolvedScript}` };
    }

    const provConfig = config.get('provisioning') || {};
    const timeout = (provConfig.shell_script_timeout_seconds || 1800) * 1000;
    log.task.info('Running sequence hook', {
      zone_name,
      phase,
      target: hook.target,
      script: hook.script,
    });
    await updateTaskProgress(task, 20, { status: 'running_hook', message: hook.script });

    let result = await runHookOnTarget({
      hook,
      ip,
      port,
      credentials,
      env,
      communicator,
      winrm,
      provisioningBasePath,
      resolvedScript,
      taskId: task.id,
      timeout,
      onData,
    });

    if (!result.success && hook.on_failure === 'continue') {
      // A failed task cancels its dependents — continue means the RUN
      // outlives the hook, so surface the failure loudly inside a success.
      onData?.({ stream: 'stderr', data: `HOOK FAILED (on_failure: continue): ${result.error}\n` });
      log.task.warn('Sequence hook failed — continuing per on_failure', {
        zone_name,
        script: hook.script,
        error: result.error,
      });
      result = {
        success: true,
        message: `${phase} hook FAILED but on_failure=continue: ${hook.script}`,
      };
    }

    if (!result.success) {
      return { success: false, error: result.error };
    }
    // Whole-walk stamp ruling: `final` rides the run's LAST step.
    if (final) {
      await updateTaskProgress(task, 95, { status: 'recording_provision_state' });
      await recordProvisionState(zone_name);
    }
    return { success: true, message: result.message || `${phase} hook completed: ${hook.script}` };
  } catch (error) {
    log.task.error('Sequence hook failed', { zone_name, error: error.message });
    return { success: false, error: `Sequence hook failed: ${error.message}` };
  }
};
