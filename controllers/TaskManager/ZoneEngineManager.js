/**
 * @fileoverview Parity-engine shared helpers (provisioning-design §5)
 * @description The winrm transport mechanics (host-ansible win_ping/win_copy/
 * win_shell over the RULED document keys: settings.vagrant_communicator +
 * vagrant_winrm_* with vagrant's own defaults), the vars→env / provision-stamp /
 * provisioning-path helpers, and the shared guest script runner. Consumed by
 * ZoneProvisionManager, ZoneEngineTasks, and the ZoneEngine/ sub-helpers
 * (one-way dependency).
 */

import { executeCommand } from '../../lib/CommandManager.js';
import { executeSSHCommand, uploadFile } from '../../lib/SSHManager.js';
import { parseConfiguration, provisioningPathFromZonepath } from '../../lib/ZoneConfigUtils.js';
import { extractControlIP } from '../../lib/ProvisionerConfigBuilder.js';
import { log } from '../../lib/Logger.js';
import Zones from '../../models/ZoneModel.js';
import { shellQuote, POSIX_NAME, legalEnvEntries } from './ZoneEngine/ShellPrimitives.js';
import {
  ANSIBLE_MISSING_WINRM,
  hostAnsibleAvailable,
  buildTransportArgs,
} from './ZoneEngine/AnsibleTransport.js';

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
