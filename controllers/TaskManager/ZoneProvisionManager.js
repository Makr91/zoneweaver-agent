/**
 * @fileoverview Zone Provisioning Task Manager for Zoneweaver Agent
 * @description Executes provisioning tasks: SSH wait, file sync, and provisioner execution.
 *              Each operation runs as a separate task in the TaskQueue with depends_on chaining.
 */

import { existsSync } from 'fs';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import { waitForSSH } from '../../lib/SSHManager.js';
import { updateTaskProgress, parseTaskMetadata } from '../../lib/TaskProgressHelper.js';
import { parseConfiguration, provisioningPathFromZonepath } from '../../lib/ZoneConfigUtils.js';
import Zones from '../../models/ZoneModel.js';
import Artifacts from '../../models/ArtifactModel.js';
import config from '../../config/ConfigLoader.js';
import {
  recordProvisionState,
  pollWinRMReady,
  runWinScriptViaAnsible,
  runScriptInGuest,
  getProvisioningBasePath,
  readDocumentControlIP,
  NO_CONTROL_IP_ERROR,
} from './ZoneEngineManager.js';
import { waitForProvisionalTransport } from '../../lib/ProvisioningNetwork.js';
import {
  wrapWithProgressScanner,
  runAnsibleLocalProvisioner,
} from './ZoneProvision/AnsibleProvisionerHelper.js';

/**
 * Execute zone SSH wait task
 * Polls until SSH is available on the zone
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneWaitSSHTask = async task => {
  const { zone_name } = task;

  try {
    const metadata = await parseTaskMetadata(task);

    const { port = 22, credentials = {}, communicator = 'ssh', winrm } = metadata;

    const provConfig = config.get('provisioning') || {};
    const sshConfig = provConfig.ssh || {};
    let timeout = (sshConfig.timeout_seconds || 300) * 1000;
    const interval = (sshConfig.poll_interval_seconds || 10) * 1000;

    await updateTaskProgress(task, 10, { status: 'waiting_for_ssh' });

    // Provisioning dataset path for relative SSH key resolution
    const zone = await Zones.findOne({ where: { name: zone_name } });
    const zoneConfig = parseConfiguration(zone);
    const provisioningBasePath = provisioningPathFromZonepath(zoneConfig.zonepath);
    // The document's settings.setup_wait wins when LARGER (Go waitSSH rule).
    const setupWait = Number(zoneConfig.settings?.setup_wait) || 0;
    if (setupWait * 1000 > timeout) {
      timeout = setupWait * 1000;
    }

    // A chain built before the guest ever booted carries no address (the
    // packaged provisional entry is a DHCP client) — poll OUR dhcpd's lease
    // and record it into the document (document honesty). Deterministic:
    // the agent reads its own server's assignment, never the guest.
    let { ip } = metadata;
    if (!ip) {
      task.onData?.({
        stream: 'stdout',
        data: 'Waiting for the provisioning lease (agent dhcpd)...\n',
      });
      ip = await waitForProvisionalTransport(zone_name, timeout, interval);
    }
    if (!ip) {
      return { success: false, error: NO_CONTROL_IP_ERROR };
    }

    // Windows guests have no sshd — readiness rides host-ansible win_ping
    // over winrm (§5 transports; settings.vagrant_communicator selects it,
    // vagrant_winrm_* carry the ruled defaults).
    if (communicator === 'winrm') {
      const ready = await pollWinRMReady(
        { ip, port, credentials, provisioningBasePath, winrm },
        timeout,
        interval,
        task.onData
      );
      if (ready.success) {
        return { success: true, message: `winrm answering on ${zone_name} (${ip})` };
      }
      return { success: false, error: ready.error };
    }

    const username = credentials.username || 'root';
    const result = await waitForSSH(
      ip,
      username,
      credentials,
      port,
      timeout,
      interval,
      provisioningBasePath
    );

    if (result.success) {
      return {
        success: true,
        message: `SSH available on ${zone_name} (${ip}:${port}) after ${Math.round(result.elapsed_ms / 1000)}s`,
      };
    }

    return {
      success: false,
      error: `${result.error} — re-provision or supply the key (vagrant_user_private_key_path)`,
    };
  } catch (error) {
    log.task.error('Zone SSH wait failed', { zone_name, error: error.message });
    return { success: false, error: `SSH wait failed: ${error.message}` };
  }
};

/**
 * Execute zone shell-script task (GRANULAR: handles ONE script).
 * Hosts.rb provisioning.shell semantics: the script is a package-relative
 * path inside the provisioning dataset. It reaches the guest by single-file
 * upload (never trusting the folder sync to have covered it), runs privileged
 * (Vagrant's shell-provisioner model: chmod +x, sudo, shebang decides the
 * interpreter), and the upload is removed afterwards.
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneShellTask = async task => {
  const { zone_name } = task;

  try {
    const metadata = await parseTaskMetadata(task);

    const {
      port = 22,
      credentials = {},
      script,
      env = {},
      communicator = 'ssh',
      winrm,
      final = false,
    } = metadata;
    const { onData } = task;

    if (!script) {
      return { success: false, error: 'script is required in task metadata' };
    }
    // The chain may predate the provisioning lease — the document is the truth.
    const ip = metadata.ip || (await readDocumentControlIP(zone_name));
    if (!ip) {
      return { success: false, error: NO_CONTROL_IP_ERROR };
    }

    const provisioningBasePath = await getProvisioningBasePath(zone_name);
    if (!script.startsWith('/') && !provisioningBasePath) {
      return {
        success: false,
        error: 'Zone has no provisioning dataset path to resolve the relative script against',
      };
    }
    const resolvedScript = script.startsWith('/') ? script : `${provisioningBasePath}/${script}`;
    if (!existsSync(resolvedScript)) {
      return {
        success: false,
        error: `Script not found in provisioning dataset: ${resolvedScript}`,
      };
    }

    const provConfig = config.get('provisioning') || {};
    const scriptTimeout = (provConfig.shell_script_timeout_seconds || 1800) * 1000;

    // Windows guests: the script rides host-ansible win_copy/win_shell over
    // winrm (§5 transport matrix — scripts ✔ on Windows guests).
    if (communicator === 'winrm') {
      await updateTaskProgress(task, 20, { status: 'running_script_winrm' });
      const winResult = await runWinScriptViaAnsible(
        { ip, port, credentials, provisioningBasePath, winrm },
        resolvedScript,
        task.id,
        { env, timeout: scriptTimeout, onData }
      );
      if (winResult.success) {
        if (final) {
          await recordProvisionState(zone_name);
        }
        return { success: true, message: `Shell script completed over winrm: ${script}` };
      }
      return { success: false, error: `Shell script failed: ${winResult.error}` };
    }

    const username = credentials.username || 'root';
    const remotePath = `/tmp/zoneweaver-shell-${task.id}`;

    log.task.info('Running shell script in zone', {
      zone_name,
      script,
      remote_path: remotePath,
    });

    // The shared guest script runner (vars→env rides WHOLE inside it; the
    // step callback keeps this task's granular progress).
    const stepPercents = { uploading_script: 10, running_script: 30, cleaning_up: 90 };
    const result = await runScriptInGuest(
      { ip, port, username, credentials, provisioningBasePath },
      resolvedScript,
      remotePath,
      {
        env,
        timeout: scriptTimeout,
        onData,
        onStep: step => updateTaskProgress(task, stepPercents[step], { status: step }),
      }
    );

    if (result.success) {
      // Whole-walk stamp ruling: `final` rides the run's LAST step,
      // whatever its type.
      if (final) {
        await updateTaskProgress(task, 95, { status: 'recording_provision_state' });
        await recordProvisionState(zone_name);
      }
      return { success: true, message: `Shell script completed: ${script}` };
    }
    return {
      success: false,
      error:
        result.output !== undefined
          ? `Shell script failed (exit ${result.exitCode}): ${script}\n${result.output}`
          : `Shell script failed: ${result.error}`,
    };
  } catch (error) {
    log.task.error('Zone shell script failed', { zone_name, error: error.message });
    return { success: false, error: `Shell script failed: ${error.message}` };
  }
};

/**
 * Execute zone provisioner task (GRANULAR: handles ONE playbook)
 * Runs a single Ansible playbook against the zone with complete extra_vars
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneProvisionTask = async task => {
  const { zone_name } = task;

  try {
    const metadata = await parseTaskMetadata(task);

    const { port = 22, credentials = {}, playbook, final = false } = metadata;

    if (!playbook) {
      return { success: false, error: 'playbook is required in task metadata' };
    }
    // The chain may predate the provisioning lease — the document is the truth.
    const ip = metadata.ip || (await readDocumentControlIP(zone_name));
    if (!ip) {
      return { success: false, error: NO_CONTROL_IP_ERROR };
    }

    // Get zone record and provisioning dataset path
    const zone = await Zones.findOne({ where: { name: zone_name } });
    if (!zone) {
      return { success: false, error: `Zone '${zone_name}' not found` };
    }

    const zoneConfig = parseConfiguration(zone);
    const provisioningBasePath = provisioningPathFromZonepath(zoneConfig.zonepath);

    // Build complete extra_vars from zone configuration
    const { buildExtraVarsFromZone, buildPlaybookExtraVars } =
      await import('../../lib/ProvisionerConfigBuilder.js');

    const provisioner = zoneConfig.provisioner || {};
    const baseExtraVars = buildExtraVarsFromZone(zone, provisioner, { provisioningBasePath });
    const extraVars = buildPlaybookExtraVars(baseExtraVars, playbook);

    log.task.info('Running ansible-local playbook', {
      zone_name,
      playbook: playbook.playbook,
      collections: playbook.collections,
      final,
    });

    // Execute ansible-local provisioner — output flows through the PROGRESS::
    // marker scanner so the callback plugin's per-role reports land in
    // progress_info live.
    const result = await runAnsibleLocalProvisioner(
      ip,
      port,
      credentials,
      { ...playbook, extra_vars: extraVars },
      provisioningBasePath,
      wrapWithProgressScanner(task, task.onData),
      task
    );

    // Update zone provisioning status
    await Zones.update({ last_seen: new Date() }, { where: { name: zone_name } });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Whole-walk stamp ruling: `final` rides the run's LAST step (whatever
    // its type) — a partial run must not mark the machine provisioned, or
    // the once/not_first run directives flip after a mid-chain failure.
    if (final) {
      await updateTaskProgress(task, 95, { status: 'recording_provision_state' });
      await recordProvisionState(zone_name);
    }

    return {
      success: true,
      message: `Playbook completed: ${playbook.playbook}`,
    };
  } catch (error) {
    log.task.error('Zone provisioning failed', { zone_name, error: error.message });
    return { success: false, error: `Provisioning failed: ${error.message}` };
  }
};

/**
 * Execute zone provisioning extraction task
 * Creates ZFS dataset and extracts artifact
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
/**
 * Create the zone's provisioning dataset at its mountpoint (idempotent — an
 * already-existing dataset passes). Shared by the artifact-extract and
 * registry-stage executors.
 * @param {string} datasetPath - Mountpoint (matches the dataset name with a leading slash)
 * @param {Function|null} onData - Output sink
 * @returns {Promise<{success: boolean, zfsDataset?: string, error?: string, details?: string}>}
 */
export const ensureProvisioningDataset = async (datasetPath, onData) => {
  const zfsDataset = datasetPath.replace(/^\/+/u, '');
  const createResult = await executeCommand(
    `pfexec zfs create -o mountpoint=${datasetPath} ${zfsDataset}`,
    undefined,
    onData
  );
  if (!createResult.success) {
    const checkResult = await executeCommand(`pfexec zfs list ${zfsDataset}`);
    if (!checkResult.success) {
      return {
        success: false,
        error: 'Failed to create provisioning dataset',
        details: createResult.error,
      };
    }
  }
  return { success: true, zfsDataset };
};

/**
 * chmod 600 every SSH private key in the staged tree (shared by the
 * artifact-extract and registry-stage executors).
 */
export const fixProvisioningKeyPermissions = (datasetPath, onData) =>
  executeCommand(
    `pfexec find ${datasetPath} -type f \\( -name 'id_rsa' -o -name 'id_dsa' -o -name 'id_ecdsa' -o -name 'id_ed25519' \\) -exec chmod 600 {} +`,
    undefined,
    onData
  );

export const executeZoneProvisioningExtractTask = async task => {
  const { zone_name } = task;

  try {
    const metadata = await parseTaskMetadata(task);

    const { artifact_id, dataset_path } = metadata;

    const artifact = await Artifacts.findByPk(artifact_id);
    if (!artifact) {
      return { success: false, error: `Artifact '${artifact_id}' not found` };
    }

    const { onData } = task;
    const ensured = await ensureProvisioningDataset(dataset_path, onData);
    if (!ensured.success) {
      return ensured;
    }

    // Extract artifact
    const extractResult = await executeCommand(
      `pfexec tar -xzf ${artifact.path} -C ${dataset_path}`,
      300000,
      onData
    );

    if (!extractResult.success) {
      return {
        success: false,
        error: 'Failed to extract provisioning artifact',
        details: extractResult.error,
      };
    }

    // Fix ownership and permissions for service user (zwagent)
    await executeCommand(`pfexec chown -R zwagent:other ${dataset_path}`, undefined, onData);
    await fixProvisioningKeyPermissions(dataset_path, onData);

    // Create snapshot
    await executeCommand(
      `pfexec zfs snapshot ${ensured.zfsDataset}@pre-provision`,
      undefined,
      onData
    );

    return { success: true, message: 'Provisioning artifact extracted successfully' };
  } catch (error) {
    log.task.error('Artifact extraction failed', { zone_name, error: error.message });
    return { success: false, error: `Extraction failed: ${error.message}` };
  }
};
