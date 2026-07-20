/**
 * @fileoverview SSH Manager for Zoneweaver Agent
 * @description Utility functions for SSH, SCP, and rsync operations against zones.
 *              Uses ssh2 library for reliable SSH connections without shell environment issues.
 */

import { Client } from 'ssh2';
import fs from 'fs';
import path from 'path';
import { executeCommand } from './CommandManager.js';
import { log } from './Logger.js';
import config from '../config/ConfigLoader.js';
import { buildConnectionOptions, buildRsyncFlags, buildSSHFlags, passwordWrap } from './SSHAuth.js';
import { pollSSH } from './SSHPoller.js';

/**
 * Get SSH key path from config or default
 * @returns {string}
 */
export const getSSHKeyPath = () => {
  const provConfig = config.get('provisioning') || {};
  const sshConfig = provConfig.ssh || {};
  return sshConfig.key_path || '/etc/zoneweaver-agent/ssh/provision_key';
};

/**
 * Resolve a credentials key path that may be package-relative against the
 * provisioning dataset — the ONE resolution rule (rsync/scp flags, ssh2
 * options, and the host-ansible transport all use it).
 * @param {string|undefined} keyPath - credentials.ssh_key_path
 * @param {string|null} provisioningBasePath - Provisioning dataset path
 * @returns {string|undefined} Resolved path (undefined when none given)
 */
export const resolveRelativeKeyPath = (keyPath, provisioningBasePath) =>
  keyPath && provisioningBasePath && !keyPath.startsWith('/')
    ? `${provisioningBasePath}/${keyPath}`
    : keyPath;

/**
 * Connect-time key selection — MARK'S THREE-TIER RULING (2026-07-17,
 * converged with the Go agent): tier 1 = the working copy's
 * vagrant_user_private_key_path when the FILE EXISTS (the machine was
 * rotated); tier 2 = the PACKAGED bootstrap key (driver/ssh_keys/id_rsa,
 * legacy core/ssh_keys/id_rsa) — a package ships the key matching the box
 * it targets, so fresh boxes just work — then the agent provisioning key.
 * Returns null when no key file exists anywhere (callers fall through to
 * password auth, then to the agent key path for an honest downstream error).
 * @param {Object} credentials - { ssh_key_path, password }
 * @param {string|null} provisioningBasePath - Provisioning dataset path
 * @returns {string|null} The chosen key path, or null
 */
export const resolveConnectKeyPath = (credentials, provisioningBasePath = null) => {
  const rotated = resolveRelativeKeyPath(credentials?.ssh_key_path, provisioningBasePath);
  if (rotated && fs.existsSync(rotated)) {
    return rotated;
  }
  const candidates = [];
  if (provisioningBasePath) {
    candidates.push(
      path.join(provisioningBasePath, 'driver', 'ssh_keys', 'id_rsa'),
      path.join(provisioningBasePath, 'core', 'ssh_keys', 'id_rsa')
    );
  }
  candidates.push(getSSHKeyPath());
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
};

/**
 * Wait for SSH to become available on a zone
 * Polls until SSH responds or timeout is reached
 * @param {string} ip - Zone IP address
 * @param {number} [port=22] - SSH port
 * @param {string} username - SSH username
 * @param {Object} credentials - { ssh_key_path } or { password }
 * @param {number} [timeout=300000] - Total timeout in milliseconds
 * @param {number} [interval=10000] - Poll interval in milliseconds
 * @returns {Promise<{success: boolean, elapsed_ms: number, error?: string}>}
 */
export const waitForSSH = async (
  ip,
  username,
  credentials,
  port = 22,
  timeout = 300000,
  interval = 10000,
  provisioningBasePath = null
) => {
  const startTime = Date.now();
  const deadline = startTime + timeout;

  let connOptions;
  try {
    connOptions = buildConnectionOptions(ip, port, username, credentials, provisioningBasePath);
  } catch (err) {
    log.task.error('Failed to build SSH connection options', { error: err.message });
    return { success: false, elapsed_ms: 0, error: err.message };
  }

  log.task.info('Waiting for SSH availability', {
    ip,
    port,
    username,
    timeout,
    auth_method: credentials.password ? 'password' : 'key',
  });

  const result = await pollSSH(connOptions, startTime, deadline, interval);

  if (!result.success) {
    if (result.cancelled) {
      log.task.info('SSH wait cancelled', { ip, port, elapsed_ms: result.elapsed_ms });
      return { ...result, error: 'SSH wait cancelled' };
    }
    log.task.error('SSH wait timed out', { ip, port, elapsed_ms: result.elapsed_ms });
    return {
      ...result,
      error: `SSH not available after ${Math.round(timeout / 1000)}s`,
    };
  }

  return result;
};

/**
 * Execute a command on a zone via SSH
 * @param {string} ip - Zone IP address
 * @param {string} username - SSH username
 * @param {Object} credentials - { ssh_key_path, password }
 * @param {string} command - Command to execute
 * @param {number} [port=22] - SSH port
 * @param {Object} [options] - { timeout: number, provisioningBasePath: string }
 * @returns {Promise<{success: boolean, stdout: string, stderr: string, exitCode: number}>}
 */
export const executeSSHCommand = (ip, username, credentials, command, port = 22, options = {}) => {
  const timeout = options.timeout || 60000;

  let connOptions;
  try {
    connOptions = buildConnectionOptions(
      ip,
      port,
      username,
      credentials,
      options.provisioningBasePath
    );
  } catch (err) {
    return {
      success: false,
      stdout: '',
      stderr: err.message,
      exitCode: 1,
    };
  }

  return new Promise(resolve => {
    const conn = new Client();
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        conn.end();
      }
    };

    const timeoutId = setTimeout(() => {
      cleanup();
      resolve({
        success: false,
        stdout: '',
        stderr: 'Command timeout',
        exitCode: 1,
      });
    }, timeout);

    conn
      .on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timeoutId);
            cleanup();
            resolve({
              success: false,
              stdout: '',
              stderr: err.message,
              exitCode: 1,
            });
            return;
          }

          let stdout = '';
          let stderr = '';
          const { onData } = options;

          stream
            .on('close', (code, signal) => {
              clearTimeout(timeoutId);
              cleanup();
              if (signal) {
                log.task.debug('SSH command terminated by signal', { signal });
              }
              resolve({
                success: code === 0,
                stdout,
                stderr,
                exitCode: code || 0,
              });
            })
            .on('data', data => {
              const chunk = data.toString();
              stdout += chunk;
              if (onData) {
                onData({ stream: 'stdout', data: chunk });
              }
            })
            .stderr.on('data', data => {
              const chunk = data.toString();
              stderr += chunk;
              if (onData) {
                onData({ stream: 'stderr', data: chunk });
              }
            });
        });
      })
      .on('error', err => {
        clearTimeout(timeoutId);
        cleanup();
        resolve({
          success: false,
          stdout: '',
          stderr: err.message,
          exitCode: 1,
        });
      })
      .connect(connOptions);
  });
};

/**
 * Sync files from host to zone via rsync over SSH
 * @param {string} ip - Zone IP address
 * @param {string} username - SSH username
 * @param {Object} credentials - { ssh_key_path, password }
 * @param {string} localDir - Local directory path (source)
 * @param {string} remoteDir - Remote directory path (destination)
 * @param {number} [port=22] - SSH port
 * @param {Object} [options] - { delete: boolean, exclude: string[], args: string[], provisioningBasePath: string }
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const syncFiles = async (
  ip,
  username,
  credentials,
  localDir,
  remoteDir,
  port = 22,
  options = {}
) => {
  const auth = buildSSHFlags(credentials, options.provisioningBasePath);
  const sshCmd = `ssh ${auth.sshOptions} -p ${port}`;
  const rsyncFlags = buildRsyncFlags(options, true);

  const source = localDir.endsWith('/') ? localDir : `${localDir}/`;

  log.task.info('Syncing files to zone', { ip, localDir, remoteDir });

  const rsyncCmd = passwordWrap(
    auth,
    `rsync ${rsyncFlags} --rsync-path='sudo rsync' -e "${sshCmd}" ${source} ${username}@${ip}:${remoteDir}`
  );

  const result = await executeCommand(rsyncCmd.trim(), 600000, options.onData);

  if (result.success) {
    return { success: true, message: `Files synced to ${ip}:${remoteDir}` };
  }
  return { success: false, error: `rsync failed: ${result.error}` };
};

/**
 * Sync a directory's CONTENT into the zone with scp -r — the per-folder scp
 * transport (folder type "scp"; shared semantics with the Go agent's SCPSync:
 * `dir/.` copies content like rsync's trailing slash; args/exclude/delete
 * have no scp equivalents and the caller narrates the downgrade). scp writes
 * as the SSH user — callers pre-create/chown the destination.
 * @param {string} ip - Zone IP address
 * @param {string} username - SSH username
 * @param {Object} credentials - { ssh_key_path, password }
 * @param {string} localDir - Local directory (source)
 * @param {string} remoteDir - Remote directory (destination)
 * @param {number} [port=22] - SSH port
 * @param {Object} [options] - { provisioningBasePath, onData }
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const scpSyncFiles = async (
  ip,
  username,
  credentials,
  localDir,
  remoteDir,
  port = 22,
  options = {}
) => {
  const auth = buildSSHFlags(credentials, options.provisioningBasePath);
  const source = `${localDir.replace(/\/+$/u, '')}/.`;

  const scpCmd = passwordWrap(
    auth,
    `scp ${auth.sshOptions} -P ${port} -r ${source} ${username}@${ip}:${remoteDir}`
  );

  const result = await executeCommand(scpCmd.trim(), 600000, options.onData);

  if (result.success) {
    return { success: true, message: `Files copied to ${ip}:${remoteDir} (scp)` };
  }
  return { success: false, error: `scp sync failed: ${result.error}` };
};

/**
 * Pull a directory's content FROM the zone via rsync over SSH (syncback).
 * The remote SENDER runs sudo rsync so root-owned results stay readable;
 * delete is never honored on pull — the caller doesn't pass it.
 * @param {string} ip - Zone IP address
 * @param {string} username - SSH username
 * @param {Object} credentials - { ssh_key_path, password }
 * @param {string} remoteDir - Remote directory (source, guest side)
 * @param {string} localDir - Local directory (destination, host side)
 * @param {number} [port=22] - SSH port
 * @param {Object} [options] - { exclude: string[], args: string[], provisioningBasePath, onData }
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const syncFilesFromZone = async (
  ip,
  username,
  credentials,
  remoteDir,
  localDir,
  port = 22,
  options = {}
) => {
  const auth = buildSSHFlags(credentials, options.provisioningBasePath);
  const sshCmd = `ssh ${auth.sshOptions} -p ${port}`;
  const rsyncFlags = buildRsyncFlags(options, false);

  const source = remoteDir.endsWith('/') ? remoteDir : `${remoteDir}/`;

  log.task.info('Pulling files from zone', { ip, remoteDir, localDir });

  const rsyncCmd = passwordWrap(
    auth,
    `rsync ${rsyncFlags} --rsync-path='sudo rsync' -e "${sshCmd}" ${username}@${ip}:${source} ${localDir}`
  );

  const result = await executeCommand(rsyncCmd.trim(), 600000, options.onData);

  if (result.success) {
    return { success: true, message: `Files pulled from ${ip}:${remoteDir}` };
  }
  return { success: false, error: `rsync pull failed: ${result.error}` };
};

/**
 * Pull a directory's content FROM the zone with scp -r (syncback, folder type
 * "scp"). scp reads as the SSH user — root-only guest files are skipped; the
 * caller narrates that.
 * @param {string} ip - Zone IP address
 * @param {string} username - SSH username
 * @param {Object} credentials - { ssh_key_path, password }
 * @param {string} remoteDir - Remote directory (source, guest side)
 * @param {string} localDir - Local directory (destination, host side)
 * @param {number} [port=22] - SSH port
 * @param {Object} [options] - { provisioningBasePath, onData }
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const scpSyncFilesFromZone = async (
  ip,
  username,
  credentials,
  remoteDir,
  localDir,
  port = 22,
  options = {}
) => {
  const auth = buildSSHFlags(credentials, options.provisioningBasePath);
  const source = `${remoteDir.replace(/\/+$/u, '')}/.`;

  const scpCmd = passwordWrap(
    auth,
    `scp ${auth.sshOptions} -P ${port} -r ${username}@${ip}:${source} ${localDir}`
  );

  const result = await executeCommand(scpCmd.trim(), 600000, options.onData);

  if (result.success) {
    return { success: true, message: `Files pulled from ${ip}:${remoteDir} (scp)` };
  }
  return { success: false, error: `scp pull failed: ${result.error}` };
};

/**
 * Upload a single file from host to zone via SCP
 * @param {string} ip - Zone IP address
 * @param {string} username - SSH username
 * @param {Object} credentials - { ssh_key_path, password }
 * @param {string} localPath - Local file path
 * @param {string} remotePath - Remote file path
 * @param {number} [port=22] - SSH port
 * @param {Object} [options] - { provisioningBasePath: string, onData: Function }
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const uploadFile = async (
  ip,
  username,
  credentials,
  localPath,
  remotePath,
  port = 22,
  options = {}
) => {
  const auth = buildSSHFlags(credentials, options.provisioningBasePath);

  const scpCmd = passwordWrap(
    auth,
    `scp ${auth.sshOptions} -P ${port} ${localPath} ${username}@${ip}:${remotePath}`
  );

  const result = await executeCommand(scpCmd.trim(), 300000, options.onData);

  if (result.success) {
    return { success: true, message: `File uploaded to ${ip}:${remotePath}` };
  }
  return { success: false, error: `scp failed: ${result.error}` };
};

/**
 * Download a file from zone to host via SCP
 * @param {string} ip - Zone IP address
 * @param {string} username - SSH username
 * @param {Object} credentials - { ssh_key_path, password }
 * @param {string} remotePath - Remote file path
 * @param {string} localPath - Local file path
 * @param {number} [port=22] - SSH port
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const downloadFile = async (ip, username, credentials, remotePath, localPath, port = 22) => {
  const auth = buildSSHFlags(credentials);

  const scpCmd = passwordWrap(
    auth,
    `scp ${auth.sshOptions} -P ${port} ${username}@${ip}:${remotePath} ${localPath}`
  );

  const result = await executeCommand(scpCmd.trim(), 300000);

  if (result.success) {
    return { success: true, message: `File downloaded from ${ip}:${remotePath}` };
  }
  return { success: false, error: `scp download failed: ${result.error}` };
};

/**
 * Generate an SSH keypair for provisioning
 * @param {string} [keyPath] - Path to store the key (default from config)
 * @returns {Promise<{success: boolean, public_key?: string, key_path?: string, error?: string}>}
 */
export const generateSSHKey = async keyPath => {
  const keyFile = keyPath || getSSHKeyPath();
  const dir = keyFile.substring(0, keyFile.lastIndexOf('/'));
  await executeCommand(`pfexec mkdir -p ${dir}`);

  const checkResult = await executeCommand(`test -f ${keyFile} && echo exists`);
  if (checkResult.success && checkResult.output && checkResult.output.includes('exists')) {
    const pubResult = await executeCommand(`cat ${keyFile}.pub`);
    return {
      success: true,
      public_key: pubResult.output || '',
      key_path: keyFile,
      message: 'SSH key already exists',
    };
  }

  const genResult = await executeCommand(
    `pfexec ssh-keygen -t ed25519 -f ${keyFile} -N "" -C "zoneweaver-agent@provisioning"`
  );

  if (!genResult.success) {
    return { success: false, error: `Failed to generate SSH key: ${genResult.error}` };
  }

  const pubResult = await executeCommand(`cat ${keyFile}.pub`);

  log.task.info('SSH provisioning key generated', { path: keyFile });
  return {
    success: true,
    public_key: pubResult.output || '',
    key_path: keyFile,
  };
};
