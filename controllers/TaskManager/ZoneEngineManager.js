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
import yj from 'yieldable-json';
import { executeCommand } from '../../lib/CommandManager.js';
import { executeSSHCommand, uploadFile } from '../../lib/SSHManager.js';
import { updateTaskProgress } from '../../lib/TaskProgressHelper.js';
import { log } from '../../lib/Logger.js';
import Zones from '../../models/ZoneModel.js';
import config from '../../config/ConfigLoader.js';

const parseTaskMetadata = task =>
  new Promise((resolve, reject) => {
    yj.parseAsync(task.metadata, (err, result) => (err ? reject(err) : resolve(result)));
  });

const getProvisioningBasePath = async zoneName => {
  const zone = await Zones.findOne({ where: { name: zoneName } });
  if (!zone?.configuration) {
    return null;
  }
  const zoneConfig =
    typeof zone.configuration === 'string' ? JSON.parse(zone.configuration) : zone.configuration;
  if (zoneConfig.zonepath) {
    return `${zoneConfig.zonepath.replace('/path', '')}/provisioning`;
  }
  return null;
};

const shellQuote = value => `'${String(value).replace(/'/gu, "'\\''")}'`;

const POSIX_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

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
    let freshConfig = freshZone?.configuration || {};
    if (typeof freshConfig === 'string') {
      freshConfig = JSON.parse(freshConfig);
    }
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

/**
 * The host-ansible gate (§5: ansible remote and the winrm mechanics are
 * gated on host ansible presence — /provisioning/status advertises it).
 * @param {string} [binary] - Binary to check (default ansible-playbook)
 * @returns {Promise<boolean>} Whether the binary resolves
 */
const hostAnsibleAvailable = async (binary = 'ansible-playbook') => {
  const result = await executeCommand(`which ${binary}`);
  return result.success;
};

/** The ruled winrm defaults (Q2: vagrant's own). */
const winrmDefaults = winrm => {
  const transport = winrm?.transport ?? 'negotiate';
  return {
    transport,
    port: winrm?.port ?? (transport === 'ssl' ? 5986 : 5985),
    ssl_peer_verification: winrm?.ssl_peer_verification ?? true,
  };
};

/**
 * Build the host-side ansible transport arguments for a guest. ssh rides the
 * provisioning key (relative paths resolve against the provisioning
 * dataset); winrm rides the RULED document keys (Q2) mapped onto ansible's
 * connection vars: transport negotiate→ntlm, ssl→ntlm over https;
 * ssl_peer_verification false → server-cert validation off.
 * @param {Object} target - {communicator, ip, port, credentials, provisioningBasePath, winrm}
 * @returns {{args: string, error?: string}}
 */
const buildTransportArgs = target => {
  const { communicator, port, credentials = {}, provisioningBasePath } = target;
  const username = credentials.username || 'root';

  if (communicator === 'winrm') {
    const winrm = winrmDefaults(target.winrm);
    const extra = [
      `-e ansible_connection=winrm`,
      `-e ansible_user=${shellQuote(username)}`,
      `-e ansible_password=${shellQuote(credentials.password || '')}`,
      `-e ansible_port=${winrm.port}`,
      `-e ansible_winrm_transport=ntlm`,
    ];
    if (winrm.transport === 'ssl') {
      extra.push('-e ansible_winrm_scheme=https');
    }
    if (winrm.ssl_peer_verification === false) {
      extra.push('-e ansible_winrm_server_cert_validation=ignore');
    }
    return { args: extra.join(' ') };
  }

  let keyPath = credentials.ssh_key_path;
  if (keyPath && provisioningBasePath && !keyPath.startsWith('/')) {
    keyPath = `${provisioningBasePath}/${keyPath}`;
  }
  if (!keyPath) {
    const provConfig = config.get('provisioning') || {};
    keyPath = provConfig.ssh?.key_path || '/etc/zoneweaver-agent/ssh/provision_key';
    if (!fs.existsSync(keyPath) && credentials.password) {
      return {
        args: '',
        error:
          'ansible remote over ssh needs a key (credentials.ssh_key_path or the provisioning key) — password-only transport is not supported host-side',
      };
    }
  }
  const args = [
    `--user ${shellQuote(username)}`,
    `--private-key ${shellQuote(keyPath)}`,
    `--ssh-common-args ${shellQuote('-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null')}`,
    `-e ansible_port=${port || 22}`,
  ];
  return { args: args.join(' ') };
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
    return {
      success: false,
      error: 'winrm transport needs ansible (+pywinrm) on the agent host — not installed',
    };
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
 * Filter an env map to POSIX-legal names with loud narration for the rest.
 * @param {Object} env - Environment map
 * @param {Function|null} onData - Output sink
 * @returns {Array<[string, string]>} Legal entries
 */
const legalEnvEntries = (env, onData) =>
  Object.entries(env || {}).filter(([key]) => {
    if (POSIX_NAME.test(key)) {
      return true;
    }
    onData?.({
      stream: 'stdout',
      data: `var "${key}" cannot become an environment variable (non-POSIX name) — skipped\n`,
    });
    return false;
  });

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
    return {
      success: false,
      error: 'winrm transport needs ansible (+pywinrm) on the agent host — not installed',
    };
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
 * Host-side env prefix for the remote runner: the playbook's ANSIBLE_CONFIG
 * plus the package's vendored collections via ANSIBLE_COLLECTIONS_PATH.
 * @param {Object} playbook - Playbook entry
 * @param {string|null} provisioningBasePath - Staged package path
 * @returns {string} Env assignment prefix ('' when nothing applies)
 */
const buildRemoteEnvPrefix = (playbook, provisioningBasePath) => {
  const envParts = [];
  if (playbook.config_file) {
    envParts.push(
      `ANSIBLE_CONFIG=${shellQuote(
        playbook.config_file.startsWith('/')
          ? playbook.config_file
          : `${provisioningBasePath}/${playbook.config_file}`
      )}`
    );
  }
  const collectionsDir = provisioningBasePath
    ? path.join(provisioningBasePath, 'provisioners', 'ansible_collections')
    : null;
  if (collectionsDir && fs.existsSync(collectionsDir)) {
    envParts.push(`ANSIBLE_COLLECTIONS_PATH=${shellQuote(collectionsDir)}`);
  }
  return envParts.length > 0 ? `${envParts.join(' ')} ` : '';
};

/**
 * remote_collections host-side galaxy installs (concurrent, the local
 * installer's own pattern).
 * @param {string} envPrefix - Host env prefix
 * @param {Object} playbook - Playbook entry
 * @param {Function|null} onData - Output sink
 * @returns {Promise<string|null>} Error message or null
 */
const installHostCollections = async (envPrefix, playbook, onData) => {
  if (playbook.remote_collections !== true || !Array.isArray(playbook.collections)) {
    return null;
  }
  const provConfig = config.get('provisioning') || {};
  const installTimeout = (provConfig.ansible_install_timeout_seconds || 300) * 1000;
  const results = await Promise.all(
    playbook.collections.map(collection =>
      executeCommand(
        `${envPrefix}ansible-galaxy collection install ${shellQuote(collection)} --force`,
        installTimeout,
        onData
      )
    )
  );
  const failed = results.find(result => !result.success);
  return failed ? `host-side galaxy install failed: ${failed.error}` : null;
};

/** Map the playbook's verbose knob onto ansible's -v flags. */
const verboseFlag = playbook => {
  if (playbook.verbose === true) {
    return ' -v';
  }
  if (typeof playbook.verbose === 'string' && /^v+$/u.test(playbook.verbose)) {
    return ` -${playbook.verbose}`;
  }
  return '';
};

/**
 * Resolve everything the remote runner needs: the zone, its staged package
 * path, the transport arguments, and the host-side playbook path.
 * @param {string} zoneName - Zone name
 * @param {Object} metadata - Task metadata
 * @returns {Promise<Object>} {error} or {zone, provisioningBasePath, transport, playbookPath}
 */
const prepareRemoteRun = async (zoneName, metadata) => {
  const { ip, port, credentials, playbook, communicator, winrm } = metadata;
  if (!(await hostAnsibleAvailable())) {
    return {
      error:
        'ansible remote needs ansible-playbook on the agent host (see /provisioning/status) — install ansible or move the playbook to the local: group',
    };
  }
  const zone = await Zones.findOne({ where: { name: zoneName } });
  if (!zone) {
    return { error: `Zone '${zoneName}' not found` };
  }
  const provisioningBasePath = await getProvisioningBasePath(zoneName);
  const transport = buildTransportArgs({
    communicator,
    ip,
    port,
    credentials,
    provisioningBasePath,
    winrm,
  });
  if (transport.error) {
    return { error: transport.error };
  }
  const playbookPath = playbook.playbook.startsWith('/')
    ? playbook.playbook
    : `${provisioningBasePath}/${playbook.playbook}`;
  if (!fs.existsSync(playbookPath)) {
    return { error: `remote playbook not found on host: ${playbookPath}` };
  }
  return { zone, provisioningBasePath, transport, playbookPath };
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
    const { ip, playbook, communicator = 'ssh', final = false } = metadata;
    const { onData } = task;
    if (!ip || !playbook?.playbook) {
      return { success: false, error: 'ip and playbook are required in task metadata' };
    }

    await updateTaskProgress(task, 10, { status: 'checking_host_ansible' });
    const prep = await prepareRemoteRun(zone_name, { ...metadata, communicator });
    if (prep.error) {
      return { success: false, error: prep.error };
    }
    const { zone, provisioningBasePath, transport, playbookPath } = prep;

    let zoneConfig = zone.configuration;
    if (typeof zoneConfig === 'string') {
      zoneConfig = JSON.parse(zoneConfig);
    }
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
    const { ip, port = 22, credentials = {}, file, final = false } = metadata;
    const { onData } = task;
    if (!ip || !file) {
      return { success: false, error: 'ip and file are required in task metadata' };
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

const runGuestHook = async (target, resolvedScript, taskId, options) => {
  const { env, timeout, onData, communicator } = options;
  if (communicator === 'winrm') {
    return runWinScriptViaAnsible(target, resolvedScript, taskId, { env, timeout, onData });
  }
  const remotePath = `/tmp/zoneweaver-hook-${taskId}`;
  const upload = await uploadFile(
    target.ip,
    target.username,
    target.credentials,
    resolvedScript,
    remotePath,
    target.port,
    { provisioningBasePath: target.provisioningBasePath, onData }
  );
  if (!upload.success) {
    return { success: false, error: `hook upload failed: ${upload.error}` };
  }
  const envArgs = shellEnvArgs(env, onData);
  const runCommand = envArgs
    ? `chmod +x ${remotePath} && sudo env ${envArgs} ${remotePath}`
    : `chmod +x ${remotePath} && sudo ${remotePath}`;
  const result = await executeSSHCommand(
    target.ip,
    target.username,
    target.credentials,
    runCommand,
    target.port,
    { timeout, provisioningBasePath: target.provisioningBasePath, onData }
  );
  await executeSSHCommand(
    target.ip,
    target.username,
    target.credentials,
    `rm -f ${remotePath}`,
    target.port,
    { provisioningBasePath: target.provisioningBasePath, onData }
  );
  if (!result.success) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n---STDERR---\n');
    return { success: false, error: `hook failed (exit ${result.exitCode}):\n${output}` };
  }
  return { success: true, message: 'hook completed in guest' };
};

/**
 * Run one hook on its target (host or guest). Host-target execution is
 * DOUBLE-gated: the pipeline pre-flight refuses unconfirmed/ungated runs,
 * and this re-checks the `provisioning.host_hooks` config (defense in
 * depth, zoneweaver default OFF).
 * @param {Object} params - {hook, ip, port, credentials, env, communicator,
 *   winrm, provisioningBasePath, resolvedScript, taskId, timeout, onData}
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const runHookOnTarget = params => {
  const { hook, resolvedScript, timeout, onData } = params;
  if (hook.target === 'host') {
    const provConfig = config.get('provisioning') || {};
    if (provConfig.host_hooks !== true) {
      return Promise.resolve({
        success: false,
        error:
          'host-target hooks are disabled on this agent (provisioning.host_hooks, zoneweaver default OFF)',
      });
    }
    const envArgs = shellEnvArgs(params.env, onData);
    const command = envArgs
      ? `chmod +x ${shellQuote(resolvedScript)} && env ${envArgs} ${shellQuote(resolvedScript)}`
      : `chmod +x ${shellQuote(resolvedScript)} && ${shellQuote(resolvedScript)}`;
    return executeCommand(command, timeout, onData).then(hostRun =>
      hostRun.success
        ? { success: true, message: 'hook completed on host' }
        : { success: false, error: `host hook failed: ${hostRun.error}` }
    );
  }
  if (!params.ip) {
    return Promise.resolve({ success: false, error: 'ip is required for guest-target hooks' });
  }
  const target = {
    ip: params.ip,
    port: params.port,
    credentials: params.credentials,
    username: params.credentials.username || 'root',
    provisioningBasePath: params.provisioningBasePath,
    winrm: params.winrm,
  };
  return runGuestHook(target, resolvedScript, params.taskId, {
    env: params.env,
    timeout,
    onData,
    communicator: params.communicator,
  });
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
      ip,
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
