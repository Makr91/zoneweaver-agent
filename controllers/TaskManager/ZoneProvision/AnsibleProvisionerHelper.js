import { executeSSHCommand } from '../../../lib/SSHManager.js';
import { updateTaskProgress } from '../../../lib/TaskProgressHelper.js';
import config from '../../../config/ConfigLoader.js';

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
export const wrapWithProgressScanner = (task, onData) => {
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
export const runAnsibleLocalProvisioner = async (
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
