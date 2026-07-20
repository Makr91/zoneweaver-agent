/**
 * @fileoverview Parity-engine executors (provisioning-design §5)
 * @description The engine ops beyond sync/shell/ansible-local: ansible
 * REMOTE (runs on the agent host over the guest transport, gated on host
 * ansible), docker_compose execution in the guest (exactly what the
 * document prescribes — no engine auto-install, no run pins), sequence
 * hooks (pre/post, host|guest targets), and the winrm transport mechanics
 * (host-ansible win_ping/win_copy/win_shell over the RULED document keys:
 * settings.vagrant_communicator + vagrant_winrm_* with vagrant's own
 * defaults). ZoneProvisionManager imports the winrm + stamp + env helpers
 * from here (one-way dependency).
 */

import fs from 'fs';
import path from 'path';
import { executeCommand } from '../../lib/CommandManager.js';
import { executeSSHCommand, uploadFile, resolveRelativeKeyPath } from '../../lib/SSHManager.js';
import { updateTaskProgress, parseTaskMetadata } from '../../lib/TaskProgressHelper.js';
import {
  parseConfiguration,
  provisioningPathFromZonepath,
  getZoneConfig,
  removeDocumentNetworkEntry,
} from '../../lib/ZoneConfigUtils.js';
import { extractControlIP } from '../../lib/ProvisionerConfigBuilder.js';
import { log } from '../../lib/Logger.js';
import Zones from '../../models/ZoneModel.js';
import config from '../../config/ConfigLoader.js';
import { shellQuote, POSIX_NAME, legalEnvEntries } from './ZoneEngine/ShellPrimitives.js';
import {
  ANSIBLE_MISSING_WINRM,
  hostAnsibleAvailable,
  buildTransportArgs,
} from './ZoneEngine/AnsibleTransport.js';
import {
  buildRemoteEnvPrefix,
  installHostCollections,
  verboseFlag,
  prepareRemoteRun,
} from './ZoneEngine/RemoteRun.js';
import { runHookOnTarget } from './ZoneEngine/HookRunner.js';

/**
 * The zone's provisioning dataset path, read from its stored record — THE
 * one lookup (ZoneProvisionManager imports it too).
 * @param {string} zoneName - Zone name
 * @returns {Promise<string|null>} Provisioning dataset path
 */
export const getProvisioningBasePath = async zoneName => {
  const zone = await Zones.findOne({ where: { name: zoneName } });
  return provisioningPathFromZonepath(parseConfiguration(zone).zonepath);
};

/**
 * The DOCUMENT's control address (is_control → provisional → first) — the
 * executors' fallback when the chain was built before the provisioning
 * lease existed: zone_wait_ssh records the lease into the document, and the
 * document is the truth from then on.
 * @param {string} zoneName - Zone name
 * @returns {Promise<string|null>} Control address or null
 */
export const readDocumentControlIP = async zoneName => {
  const zone = await Zones.findOne({ where: { name: zoneName } });
  return zone ? extractControlIP(parseConfiguration(zone).networks || []) : null;
};

/** The one wording for a missing transport address (the document carries
 * none and no provisioning lease has been recorded). */
export const NO_CONTROL_IP_ERROR =
  'No control address in the document — set is_control: true on a networks[] entry, or run the provision pipeline so zone_wait_ssh records the provisioning lease';

/**
 * vars→env (§5): the document's vars ride WHOLE — every key under its EXACT
 * name, values pre-stringified (lists/dicts as JSON). Names env(1) cannot
 * carry are narrated-and-skipped HERE, loudly, never silently at build.
 * @param {Object} env - Environment map
 * @param {Function|null} onData - Output sink for the skip narration
 * @returns {string} Space-joined `K='v'` assignments ('' when empty)
 */
export const shellEnvArgs = (env, onData = null) => {
  const parts = [];
  for (const [key, value] of Object.entries(env || {})) {
    if (!POSIX_NAME.test(key)) {
      onData?.({
        stream: 'stdout',
        data: `var "${key}" cannot become an environment variable (non-POSIX name) — skipped\n`,
      });
      continue;
    }
    parts.push(`${key}=${shellQuote(value)}`);
  }
  return parts.join(' ');
};

/**
 * Stamp the machine provisioned — the whole-walk ruling: `final` rides the
 * run's LAST step (whatever its type), so the stamp marks "a full
 * provisioning run completed" and a partial run never flips the
 * once/not_first directives.
 * @param {string} zoneName - Zone name
 */
export const recordProvisionState = async zoneName => {
  try {
    const freshZone = await Zones.findOne({ where: { name: zoneName } });
    const freshConfig = parseConfiguration(freshZone);
    freshConfig.provisioner_state = {
      ...(freshConfig.provisioner_state || {}),
      last_provisioned_at: new Date().toISOString(),
    };
    await Zones.update({ configuration: freshConfig }, { where: { name: zoneName } });
  } catch (stateError) {
    log.task.warn('Failed to record provision state', {
      zone_name: zoneName,
      error: stateError.message,
    });
  }
};

/** The ruled winrm defaults (Q2: vagrant's own) — the ONE place they live;
 * the chain builder's alias resolver imports this. */
export const winrmDefaults = winrm => {
  const transport = winrm?.transport ?? 'negotiate';
  return {
    transport,
    port: winrm?.port ?? (transport === 'ssl' ? 5986 : 5985),
    ssl_peer_verification: winrm?.ssl_peer_verification ?? true,
  };
};

/**
 * Poll guest readiness over winrm via host-ansible win_ping — the
 * zone_wait_ssh analog for Windows guests (no sshd to wait on). Sequential
 * recursion, the ssh poller's own pattern.
 * @param {Object} target - {ip, port, credentials, provisioningBasePath, winrm}
 * @param {number} timeoutMs - Total wait
 * @param {number} intervalMs - Poll interval
 * @param {Function|null} onData - Output sink
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const pollWinRMReady = async (target, timeoutMs, intervalMs, onData) => {
  if (!(await hostAnsibleAvailable('ansible'))) {
    return { success: false, error: ANSIBLE_MISSING_WINRM };
  }
  const transport = buildTransportArgs({ ...target, communicator: 'winrm' });
  const deadline = Date.now() + timeoutMs;
  const command = `ansible all -i ${shellQuote(`${target.ip},`)} -m ansible.windows.win_ping ${transport.args}`;

  const check = async () => {
    const result = await executeCommand(command, Math.min(intervalMs * 3, 60000), onData);
    if (result.success) {
      return { success: true };
    }
    if (Date.now() >= deadline) {
      return {
        success: false,
        error: `winrm not answering after ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    await new Promise(resolve => {
      setTimeout(resolve, intervalMs);
    });
    return check();
  };
  return check();
};

/**
 * Run a HOST-LOCAL script upload+exec on a WINDOWS guest via host-ansible
 * (win_copy + win_shell + win_file cleanup) — the scripts row of the §5
 * transport matrix without a hand-rolled SOAP client.
 * @param {Object} target - {ip, port, credentials, provisioningBasePath, winrm}
 * @param {string} localScript - Host path of the script
 * @param {string} taskId - Task id (names the guest temp file)
 * @param {Object} options - {env, timeout, onData}
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const runWinScriptViaAnsible = async (target, localScript, taskId, options = {}) => {
  if (!(await hostAnsibleAvailable('ansible'))) {
    return { success: false, error: ANSIBLE_MISSING_WINRM };
  }
  const transport = buildTransportArgs({ ...target, communicator: 'winrm' });
  const inventory = shellQuote(`${target.ip},`);
  const remotePath = `C:\\Windows\\Temp\\zw-shell-${taskId}.ps1`;
  const { env = {}, timeout = 1800000, onData = null } = options;

  const copy = await executeCommand(
    `ansible all -i ${inventory} -m ansible.windows.win_copy -a ${shellQuote(`src=${localScript} dest=${remotePath}`)} ${transport.args}`,
    300000,
    onData
  );
  if (!copy.success) {
    return { success: false, error: `script upload over winrm failed: ${copy.error}` };
  }

  const envPrefix = legalEnvEntries(env, onData)
    .map(([key, value]) => `$env:${key} = '${String(value).replace(/'/gu, "''")}'; `)
    .join('');
  const run = await executeCommand(
    `ansible all -i ${inventory} -m ansible.windows.win_shell -a ${shellQuote(`${envPrefix}& '${remotePath}'`)} ${transport.args}`,
    timeout,
    onData
  );

  await executeCommand(
    `ansible all -i ${inventory} -m ansible.windows.win_file -a ${shellQuote(`path=${remotePath} state=absent`)} ${transport.args}`,
    120000,
    onData
  );

  if (!run.success) {
    return { success: false, error: `script failed over winrm: ${run.error}` };
  }
  return { success: true, message: 'script completed over winrm' };
};

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
 * Upload one host-side script into the guest over ssh, run it privileged
 * (chmod +x, sudo, vars→env prefix), and remove the upload afterwards
 * (best-effort) — the ONE script runner the shell method and guest hooks
 * share. onStep narrates the stages for callers tracking progress.
 * @param {Object} target - {ip, port, username, credentials, provisioningBasePath}
 * @param {string} resolvedScript - Host path of the script
 * @param {string} remotePath - Guest-side upload path
 * @param {Object} options - {env, timeout, onData, onStep}
 * @returns {Promise<{success: boolean, exitCode?: number, output?: string, error?: string}>}
 */
export const runScriptInGuest = async (target, resolvedScript, remotePath, options = {}) => {
  const { env = {}, timeout, onData = null, onStep = null } = options;
  const sshOptions = { provisioningBasePath: target.provisioningBasePath, onData };

  await onStep?.('uploading_script');
  const upload = await uploadFile(
    target.ip,
    target.username,
    target.credentials,
    resolvedScript,
    remotePath,
    target.port,
    sshOptions
  );
  if (!upload.success) {
    return { success: false, error: `script upload failed: ${upload.error}` };
  }

  const envArgs = shellEnvArgs(env, onData);
  const runCommand = envArgs
    ? `chmod +x ${remotePath} && sudo env ${envArgs} ${remotePath}`
    : `chmod +x ${remotePath} && sudo ${remotePath}`;
  await onStep?.('running_script');
  const result = await executeSSHCommand(
    target.ip,
    target.username,
    target.credentials,
    runCommand,
    target.port,
    { timeout, ...sshOptions }
  );

  // Best-effort cleanup — never fails the run.
  await onStep?.('cleaning_up');
  await executeSSHCommand(
    target.ip,
    target.username,
    target.credentials,
    `rm -f ${remotePath}`,
    target.port,
    sshOptions
  );

  if (!result.success) {
    return {
      success: false,
      exitCode: result.exitCode,
      output: [result.stdout, result.stderr].filter(Boolean).join('\n---STDERR---\n'),
    };
  }
  return { success: true };
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
