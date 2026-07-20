import { readFileSync } from 'fs';
import { getSSHKeyPath, resolveConnectKeyPath } from './SSHManager.js';

/** Prefix a command with sshpass when the auth resolved to password. */
export const passwordWrap = (auth, command) =>
  auth.usePassword ? `sshpass -p '${auth.password}' ${command}` : command;

/**
 * Assemble the rsync flag string (vagrant-zones defaults, per-folder args/
 * exclude, delete only where honored) — shared by push and pull.
 * @param {Object} options - { args, exclude, delete }
 * @param {boolean} allowDelete - Whether --delete is honored on this direction
 * @returns {string} Flag string
 */
export const buildRsyncFlags = (options, allowDelete) => {
  const defaultArgs = ['--verbose', '--archive', '-z', '--copy-links'];
  let rsyncFlags = (options.args || defaultArgs).join(' ');
  if (allowDelete && options.delete) {
    rsyncFlags += ' --delete';
  }
  if (options.exclude && options.exclude.length > 0) {
    for (const pattern of options.exclude) {
      rsyncFlags += ` --exclude='${pattern}'`;
    }
  }
  return rsyncFlags;
};

/**
 * Build SSH command-line flags for rsync/scp
 * @param {Object} credentials - { ssh_key_path, password }
 * @param {string} [provisioningBasePath] - Base path for resolving relative key paths
 * @returns {{sshOptions: string, usePassword: boolean, password: string}}
 */
export const buildSSHFlags = (credentials, provisioningBasePath = null) => {
  const baseOpts = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR';

  const keyPath = resolveConnectKeyPath(credentials, provisioningBasePath);
  if (keyPath) {
    return {
      sshOptions: `${baseOpts} -i ${keyPath}`,
      usePassword: false,
      password: '',
    };
  }

  if (credentials.password) {
    return {
      sshOptions: baseOpts,
      usePassword: true,
      password: credentials.password,
    };
  }

  return {
    sshOptions: `${baseOpts} -i ${getSSHKeyPath()}`,
    usePassword: false,
    password: '',
  };
};

/**
 * Build SSH connection options for ssh2
 * @param {string} ip - Server IP address
 * @param {number} port - SSH port
 * @param {string} username - SSH username
 * @param {Object} credentials - { username, password, ssh_key_path }
 * @param {string} [provisioningBasePath] - Base path for resolving relative key paths
 * @returns {Object} ssh2 connection options
 */
export const buildConnectionOptions = (
  ip,
  port,
  username,
  credentials,
  provisioningBasePath = null
) => {
  const options = {
    host: ip,
    port,
    username,
    readyTimeout: 15000,
  };

  const keyPath = resolveConnectKeyPath(credentials, provisioningBasePath);
  if (keyPath) {
    try {
      options.privateKey = readFileSync(keyPath);
    } catch (err) {
      throw new Error(`Failed to read SSH key at ${keyPath}: ${err.message}`);
    }
    return options;
  }

  if (credentials.password) {
    options.password = credentials.password;
    return options;
  }

  try {
    options.privateKey = readFileSync(getSSHKeyPath());
  } catch (err) {
    throw new Error(`Failed to read default SSH key: ${err.message}`);
  }
  return options;
};
