/**
 * @fileoverview Zone Provisioning Task Manager for Zoneweaver Agent
 * @description Executes provisioning tasks: SSH wait, file sync, and provisioner execution.
 *              Each operation runs as a separate task in the TaskQueue with depends_on chaining.
 */

import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import {
  waitForSSH,
  executeSSHCommand,
  syncFiles,
  scpSyncFiles,
  syncFilesFromZone,
  scpSyncFilesFromZone,
} from '../../lib/SSHManager.js';
import { updateTaskProgress } from '../../lib/TaskProgressHelper.js';
import Zones from '../../models/ZoneModel.js';
import Artifacts from '../../models/ArtifactModel.js';
import config from '../../config/ConfigLoader.js';
import yj from 'yieldable-json';

/**
 * STARTcloud ansible progress adoption — the callback-plugin contract
 * (startcloud_progress.py): one machine-readable stdout line per completed
 * role, `PROGRESS::{"completed", "total", "percent", "running", "index",
 * "done", "label"}`; 100% (done: true) fires only at play end. That stdout is
 * the ONLY channel the guest's progress reaches the agent.
 */
const PROGRESS_MARKER = 'PROGRESS::';

/**
 * Wrap a task's output sink with the PROGRESS:: marker scanner. Chunks arrive
 * at arbitrary SSH-stream boundaries, so stdout is line-buffered; each marker
 * payload folds into the task's progress_info — the shared shape with the Go
 * agent: {status: running_playbook, ansible_percent, message}, task percent
 * mapped into the running_playbook window (40→90; 95 is the provisioner-state
 * stamp, 100 completed).
 * @param {Object} task - Task record
 * @param {Function|null} onData - Downstream output sink ({stream, data})
 * @returns {Function} Progress-aware output sink
 */
const wrapWithProgressScanner = (task, onData) => {
  let pending = '';

  const scanLine = line => {
    const start = line.indexOf(PROGRESS_MARKER);
    if (start < 0) {
      return;
    }
    let payload = line.substring(start + PROGRESS_MARKER.length);
    const end = payload.lastIndexOf('}');
    if (end >= 0) {
      payload = payload.substring(0, end + 1);
    }
    let progress;
    try {
      progress = JSON.parse(payload);
    } catch {
      return; // not a parseable marker line
    }
    if (typeof progress.percent !== 'number' || progress.percent < 0 || progress.percent > 100) {
      return;
    }
    let message = typeof progress.label === 'string' ? progress.label.trim() : '';
    if (!message && progress.running) {
      message = progress.running;
    }
    if (!message && progress.done) {
      message = 'completed';
    }
    if (!message) {
      return;
    }
    const ansiblePercent = Math.round(progress.percent);
    // Fire-and-forget: progress never fails or stalls the run.
    updateTaskProgress(task, 40 + ansiblePercent / 2, {
      status: 'running_playbook',
      ansible_percent: ansiblePercent,
      message,
    });
  };

  return chunk => {
    if (onData) {
      onData(chunk);
    }
    if (!chunk || chunk.stream !== 'stdout') {
      return;
    }
    pending += chunk.data;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      scanLine(pending.substring(0, newline));
      pending = pending.substring(newline + 1);
      newline = pending.indexOf('\n');
    }
    // Newline-less streams must not grow the buffer unboundedly — keep a tail
    // comfortably larger than any marker payload.
    if (pending.length > 64 * 1024) {
      pending = pending.substring(pending.length - 4096);
    }
  };
};

/**
 * Install Ansible inside zone via SSH
 * @param {string} ip - Zone IP
 * @param {string} username - SSH username
 * @param {Object} credentials - SSH credentials
 * @param {number} port - SSH port
 * @param {string} installMode - Installation method (pip or pkg)
 * @param {string} provisioningBasePath - Base path for provisioning
 */
const installAnsibleInZone = async (
  ip,
  username,
  credentials,
  port,
  installMode,
  provisioningBasePath,
  timeout = 300000,
  onData = null
) => {
  if (installMode === 'pip') {
    await executeSSHCommand(
      ip,
      username,
      credentials,
      'pip3 install ansible 2>/dev/null || pip install ansible 2>/dev/null',
      port,
      { timeout, provisioningBasePath, onData }
    );
  } else if (installMode === 'pkg') {
    await executeSSHCommand(
      ip,
      username,
      credentials,
      'pkg install ansible 2>/dev/null || apt-get install -y ansible 2>/dev/null || yum install -y ansible 2>/dev/null',
      port,
      { timeout, provisioningBasePath, onData }
    );
  }
};

/**
 * Install Ansible collections inside zone
 * @param {string} ip - Zone IP
 * @param {string} username - SSH username
 * @param {Object} credentials - SSH credentials
 * @param {number} port - SSH port
 * @param {Array} collections - Collection names
 * @param {string} provisioningBasePath - Base path for provisioning
 */
const installAnsibleCollections = async (
  ip,
  username,
  credentials,
  port,
  collections,
  provisioningBasePath,
  timeout = 300000,
  onData = null
) => {
  if (collections.length > 0) {
    const collectionInstalls = collections.map(collection =>
      executeSSHCommand(
        ip,
        username,
        credentials,
        `ansible-galaxy collection install ${collection} --force`,
        port,
        { timeout, provisioningBasePath, onData }
      )
    );
    await Promise.all(collectionInstalls);
  }
};

/**
 * Run ansible-local provisioner INSIDE zone via SSH
 * @param {string} ip
 * @param {number} port
 * @param {Object} credentials
 * @param {Object} provisioner - { playbook, extra_vars, collections, remote_collections, install_mode }
 * @param {string} provisioningBasePath
 * @param {Function|null} onData - Output sink
 * @param {Object|null} task - Task record for phase progress
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const runAnsibleLocalProvisioner = async (
  ip,
  port,
  credentials,
  provisioner,
  provisioningBasePath,
  onData = null,
  task = null
) => {
  const {
    playbook,
    extra_vars = {},
    collections = [],
    remote_collections,
    install_mode,
    config_file,
  } = provisioner;
  const username = credentials.username || 'root';

  if (!playbook) {
    return { success: false, error: 'playbook is required for ansible_local provisioner' };
  }

  const provConfig = config.get('provisioning') || {};
  const installTimeout = (provConfig.ansible_install_timeout_seconds || 300) * 1000;
  const playbookTimeout = (provConfig.playbook_timeout_seconds || 21600) * 1000;

  await updateTaskProgress(task, 10, { status: 'installing_ansible' });
  await installAnsibleInZone(
    ip,
    username,
    credentials,
    port,
    install_mode,
    provisioningBasePath,
    installTimeout,
    onData
  );

  await updateTaskProgress(task, 25, { status: 'installing_collections' });
  if (remote_collections === true) {
    await installAnsibleCollections(
      ip,
      username,
      credentials,
      port,
      collections,
      provisioningBasePath,
      installTimeout,
      onData
    );
  } else if (collections.length > 0 && onData) {
    // Hosts.rb's remote_collections contract (shared with the Go agent): the
    // collections ship INSIDE the provisioner package and reach the zone
    // through the folder sync — ansible-galaxy is never called for them.
    onData({
      stream: 'stdout',
      data: 'Collections are package-local (remote_collections not enabled) — skipping ansible-galaxy\n',
    });
  }

  await updateTaskProgress(task, 40, { status: 'running_playbook' });

  // Build extra-vars
  let extraVarsArg = '';
  if (Object.keys(extra_vars).length > 0) {
    const varsJson = JSON.stringify(extra_vars).replace(/'/g, "'\\''");
    extraVarsArg = `--extra-vars '${varsJson}'`;
  }

  // Build command matching Vagrant's ansible_local provisioner behavior:
  // cd to provisioning_path, set ANSIBLE_CONFIG if config_file specified
  const provisioningPath = provisioner.provisioning_path || '/vagrant';
  const ansibleConfigEnv = config_file ? `ANSIBLE_CONFIG=${config_file} ` : '';
  const cmd = `cd ${provisioningPath} && ${ansibleConfigEnv}ansible-playbook -i 'localhost,' -c local ${playbook} ${extraVarsArg}`;

  const result = await executeSSHCommand(ip, username, credentials, cmd, port, {
    timeout: playbookTimeout,
    provisioningBasePath,
    onData,
  });

  if (result.success) {
    return { success: true, message: `Ansible-local playbook completed: ${playbook}` };
  }
  const errorOutput = [result.stdout, result.stderr].filter(Boolean).join('\n---STDERR---\n');
  return { success: false, error: `Ansible-local failed:\n${errorOutput}` };
};

/**
 * Execute zone SSH wait task
 * Polls until SSH is available on the zone
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneWaitSSHTask = async task => {
  const { zone_name } = task;

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(task.metadata, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { ip, port = 22, credentials = {} } = metadata;

    if (!ip) {
      return { success: false, error: 'ip is required in task metadata' };
    }

    const provConfig = config.get('provisioning') || {};
    const sshConfig = provConfig.ssh || {};
    let timeout = (sshConfig.timeout_seconds || 300) * 1000;
    const interval = (sshConfig.poll_interval_seconds || 10) * 1000;

    await updateTaskProgress(task, 10, { status: 'waiting_for_ssh' });

    // Get provisioning dataset path for relative SSH key resolution
    const zone = await Zones.findOne({ where: { name: zone_name } });
    let provisioningBasePath = null;
    if (zone?.configuration) {
      const zoneConfig =
        typeof zone.configuration === 'string'
          ? JSON.parse(zone.configuration)
          : zone.configuration;
      if (zoneConfig.zonepath) {
        const zoneDataset = zoneConfig.zonepath.replace('/path', '');
        provisioningBasePath = `${zoneDataset}/provisioning`;
      }
      // The document's settings.setup_wait wins when LARGER (Go waitSSH rule).
      const setupWait = Number(zoneConfig.settings?.setup_wait) || 0;
      if (setupWait * 1000 > timeout) {
        timeout = setupWait * 1000;
      }
    }

    const result = await waitForSSH(
      ip,
      credentials.username || 'root',
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

    return { success: false, error: result.error };
  } catch (error) {
    log.task.error('Zone SSH wait failed', { zone_name, error: error.message });
    return { success: false, error: `SSH wait failed: ${error.message}` };
  }
};

/**
 * Get provisioning base path from zone configuration
 * @param {string} zoneName - Zone name
 * @returns {Promise<string|null>} Provisioning base path
 */
const getProvisioningBasePath = async zoneName => {
  const zone = await Zones.findOne({ where: { name: zoneName } });
  if (!zone?.configuration) {
    return null;
  }
  const zoneConfig =
    typeof zone.configuration === 'string' ? JSON.parse(zone.configuration) : zone.configuration;
  if (zoneConfig.zonepath) {
    const zoneDataset = zoneConfig.zonepath.replace('/path', '');
    return `${zoneDataset}/provisioning`;
  }
  return null;
};

/**
 * Run one folder's transfer over its configured transport: scp copies the
 * tree verbatim (args/exclude/delete have no scp equivalents and are
 * narrated as ignored); everything else rides rsync with its full options.
 */
const runFolderTransfer = (transfer, folder, onData) => {
  const { ip, username, credentials, resolvedSource, dest, port, provisioningBasePath } = transfer;
  if ((folder.type || '').toLowerCase() === 'scp') {
    if (folder.args || folder.exclude || folder.delete) {
      onData?.({
        stream: 'stdout',
        data: 'scp transport: args/exclude/delete have no scp equivalents — ignored\n',
      });
    }
    return scpSyncFiles(ip, username, credentials, resolvedSource, dest, port, {
      provisioningBasePath,
      onData,
    });
  }
  return syncFiles(ip, username, credentials, resolvedSource, dest, port, {
    exclude: folder.exclude,
    args: folder.args,
    delete: folder.delete,
    provisioningBasePath,
    onData,
  });
};

/**
 * Chown synced files to the folder's owner (matching vagrant-zones behavior);
 * a failure is narrated, never fatal.
 */
const applySyncOwnership = async (transfer, folder, zoneName, onData) => {
  const { ip, username, credentials, dest, port, provisioningBasePath } = transfer;
  const syncOwner = folder.owner || username;
  const syncGroup = folder.group || syncOwner;
  const chownResult = await executeSSHCommand(
    ip,
    username,
    credentials,
    `sudo chown -R ${syncOwner}:${syncGroup} ${dest}`,
    port,
    { provisioningBasePath, onData }
  );
  if (!chownResult.success) {
    log.task.warn('Failed to set ownership on synced files', {
      zone_name: zoneName,
      dest,
      owner: syncOwner,
      error: chownResult.stderr,
    });
  }
};

/**
 * Execute zone file sync task (GRANULAR: handles ONE folder)
 * Syncs a single provisioning folder from host to zone via rsync
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneSyncTask = async task => {
  const { zone_name } = task;

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(task.metadata, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { ip, port = 22, credentials = {}, folder } = metadata;
    const { onData } = task;

    if (!ip || !folder) {
      return { success: false, error: 'ip and folder are required in task metadata' };
    }

    const { map, to, disabled = false } = folder;
    const source = map || folder.source;
    const dest = to || folder.dest;

    if (disabled || (folder.type || '').toLowerCase() === 'virtualbox') {
      return {
        success: true,
        message: `Folder sync skipped (${disabled ? 'disabled' : 'virtualbox shared folders are never used'})`,
      };
    }

    if (!source || !dest) {
      return { success: false, error: 'Folder missing source (map) or destination (to)' };
    }

    const provisioningBasePath = await getProvisioningBasePath(zone_name);
    const resolvedSource = source.startsWith('/') ? source : `${provisioningBasePath}/${source}`;
    const transfer = {
      ip,
      port,
      credentials,
      username: credentials.username || 'root',
      resolvedSource,
      dest,
      provisioningBasePath,
    };

    log.task.info('Syncing folder to zone', { zone_name, source: resolvedSource, dest });

    // Pre-create destination directory
    await updateTaskProgress(task, 10, { status: 'creating_destination' });
    await executeSSHCommand(ip, transfer.username, credentials, `sudo mkdir -p ${dest}`, port, {
      provisioningBasePath,
      onData,
    });

    await updateTaskProgress(task, 30, { status: 'syncing_files' });
    const result = await runFolderTransfer(transfer, folder, onData);
    if (!result.success) {
      return { success: false, error: `${source} → ${dest}: ${result.error}` };
    }

    await updateTaskProgress(task, 85, { status: 'setting_ownership' });
    await applySyncOwnership(transfer, folder, zone_name, onData);

    return {
      success: true,
      message: `Synced folder: ${source} → ${dest}`,
    };
  } catch (error) {
    log.task.error('Zone file sync failed', { zone_name, error: error.message });
    return { success: false, error: `File sync failed: ${error.message}` };
  }
};

/**
 * Execute zone syncback task (GRANULAR: handles ONE flagged folder).
 * The push reversed — guest folder.to pulls back to host folder.map
 * (shared semantics with the Go agent's machine_syncback): folder.delete is
 * never honored on pull, pulled files stay agent-owned (no chown),
 * args/exclude ride the rsync path; scp pulls read as the SSH user.
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneSyncbackTask = async task => {
  const { zone_name } = task;

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(task.metadata, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { ip, port = 22, credentials = {}, folder } = metadata;
    const { onData } = task;

    if (!ip || !folder) {
      return { success: false, error: 'ip and folder are required in task metadata' };
    }

    const source = folder.to || folder.dest;
    const dest = folder.map || folder.source;
    if (!source || !dest) {
      return { success: false, error: 'Folder missing source (to) or destination (map)' };
    }

    const provisioningBasePath = await getProvisioningBasePath(zone_name);
    const resolvedDest = dest.startsWith('/') ? dest : `${provisioningBasePath}/${dest}`;
    const username = credentials.username || 'root';

    log.task.info('Pulling folder from zone (syncback)', {
      zone_name,
      source,
      dest: resolvedDest,
    });

    await updateTaskProgress(task, 30, { status: 'pulling_files' });
    let result;
    if ((folder.type || '').toLowerCase() === 'scp') {
      if (folder.args || folder.exclude || folder.delete) {
        onData?.({
          stream: 'stdout',
          data: 'scp transport: args/exclude/delete have no scp equivalents — ignored\n',
        });
      }
      onData?.({
        stream: 'stdout',
        data: 'scp pull reads as the SSH user — root-only guest files are skipped\n',
      });
      result = await scpSyncFilesFromZone(ip, username, credentials, source, resolvedDest, port, {
        provisioningBasePath,
        onData,
      });
    } else {
      if (folder.delete) {
        onData?.({
          stream: 'stdout',
          data: 'folder.delete is never honored on syncback — ignored\n',
        });
      }
      result = await syncFilesFromZone(ip, username, credentials, source, resolvedDest, port, {
        exclude: folder.exclude,
        args: folder.args,
        provisioningBasePath,
        onData,
      });
    }
    if (!result.success) {
      return { success: false, error: `${source} → ${resolvedDest}: ${result.error}` };
    }

    return {
      success: true,
      message: `Pulled folder: ${source} → ${resolvedDest}`,
    };
  } catch (error) {
    log.task.error('Zone syncback failed', { zone_name, error: error.message });
    return { success: false, error: `Syncback failed: ${error.message}` };
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
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(task.metadata, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { ip, port = 22, credentials = {}, playbook, final = false } = metadata;

    if (!ip) {
      return { success: false, error: 'ip is required in task metadata' };
    }

    if (!playbook) {
      return { success: false, error: 'playbook is required in task metadata' };
    }

    // Get zone record and provisioning dataset path
    const zone = await Zones.findOne({ where: { name: zone_name } });
    if (!zone) {
      return { success: false, error: `Zone '${zone_name}' not found` };
    }

    let zoneConfig = zone.configuration;
    if (typeof zoneConfig === 'string') {
      try {
        zoneConfig = JSON.parse(zoneConfig);
      } catch (e) {
        log.task.warn('Failed to parse zone configuration', { error: e.message });
        zoneConfig = {};
      }
    }

    let provisioningBasePath = null;
    if (zoneConfig.zonepath) {
      const zoneDataset = zoneConfig.zonepath.replace('/path', '');
      provisioningBasePath = `${zoneDataset}/provisioning`;
    }

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

    // Mark the machine as provisioned — Hosts.rb's results.yml semantics: the
    // stamp fires ONLY on the run's FINAL playbook. A partial run must not
    // mark the machine provisioned, or the once/not_first run directives flip
    // after a mid-chain failure.
    if (final) {
      await updateTaskProgress(task, 95, { status: 'recording_provision_state' });
      try {
        const freshZone = await Zones.findOne({ where: { name: zone_name } });
        let freshConfig = freshZone?.configuration || {};
        if (typeof freshConfig === 'string') {
          freshConfig = JSON.parse(freshConfig);
        }
        freshConfig.provisioner_state = {
          ...(freshConfig.provisioner_state || {}),
          last_provisioned_at: new Date().toISOString(),
        };
        await Zones.update({ configuration: freshConfig }, { where: { name: zone_name } });
      } catch (stateError) {
        log.task.warn('Failed to record provision state', {
          zone_name,
          error: stateError.message,
        });
      }
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
export const executeZoneProvisioningExtractTask = async task => {
  const { zone_name } = task;

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(task.metadata, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { artifact_id, dataset_path } = metadata;

    const artifact = await Artifacts.findByPk(artifact_id);
    if (!artifact) {
      return { success: false, error: `Artifact '${artifact_id}' not found` };
    }

    // Create ZFS dataset
    // dataset_path is like "/rpool/zones/myzone/provisioning" (mountpoint)
    // We need the ZFS dataset name (rpool/zones/myzone/provisioning)
    // Assuming dataset_path is the mountpoint which matches the dataset name with leading slash
    const zfsDataset = dataset_path.replace(/^\/+/, '');
    const { onData } = task;

    const createResult = await executeCommand(
      `pfexec zfs create -o mountpoint=${dataset_path} ${zfsDataset}`,
      undefined,
      onData
    );

    // Check if dataset exists if creation failed (idempotency)
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

    // Fix SSH private key permissions (600 for security)
    await executeCommand(
      `pfexec find ${dataset_path} -type f \\( -name 'id_rsa' -o -name 'id_dsa' -o -name 'id_ecdsa' -o -name 'id_ed25519' \\) -exec chmod 600 {} +`,
      undefined,
      onData
    );

    // Create snapshot
    await executeCommand(`pfexec zfs snapshot ${zfsDataset}@pre-provision`, undefined, onData);

    return { success: true, message: 'Provisioning artifact extracted successfully' };
  } catch (error) {
    log.task.error('Artifact extraction failed', { zone_name, error: error.message });
    return { success: false, error: `Extraction failed: ${error.message}` };
  }
};
