import { getSSHKeyPath, resolveConnectKeyPath } from '../../../lib/SSHManager.js';
import { executeCommand } from '../../../lib/CommandManager.js';
import { winrmDefaults } from '../ZoneEngineManager.js';
import { shellQuote } from './ShellPrimitives.js';

/** The one wording for a winrm/remote run on an ansible-less agent host. */
export const ANSIBLE_MISSING_WINRM =
  'winrm transport needs ansible (+pywinrm) on the agent host — not installed';

/**
 * The host-ansible gate (§5: ansible remote and the winrm mechanics are
 * gated on host ansible presence — /provisioning/status advertises it).
 * @param {string} [binary] - Binary to check (default ansible-playbook)
 * @returns {Promise<boolean>} Whether the binary resolves
 */
export const hostAnsibleAvailable = async (binary = 'ansible-playbook') => {
  const result = await executeCommand(`which ${binary}`);
  return result.success;
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
export const buildTransportArgs = target => {
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

  // The three-tier connect ruling governs the host-ansible transport too.
  let keyPath = resolveConnectKeyPath(credentials, provisioningBasePath);
  if (!keyPath) {
    if (credentials.password) {
      return {
        args: '',
        error:
          'ansible remote over ssh needs a key (credentials.ssh_key_path or the provisioning key) — password-only transport is not supported host-side',
      };
    }
    // No key exists anywhere — the agent key path errors honestly downstream.
    keyPath = getSSHKeyPath();
  }
  const args = [
    `--user ${shellQuote(username)}`,
    `--private-key ${shellQuote(keyPath)}`,
    `--ssh-common-args ${shellQuote('-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null')}`,
    `-e ansible_port=${port || 22}`,
  ];
  return { args: args.join(' ') };
};
