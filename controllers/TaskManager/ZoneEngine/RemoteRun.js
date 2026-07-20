import fs from 'fs';
import path from 'path';
import { executeCommand } from '../../../lib/CommandManager.js';
import config from '../../../config/ConfigLoader.js';
import Zones from '../../../models/ZoneModel.js';
import { getProvisioningBasePath } from '../ZoneEngineManager.js';
import { shellQuote } from './ShellPrimitives.js';
import { hostAnsibleAvailable, buildTransportArgs } from './AnsibleTransport.js';

/**
 * Host-side env prefix for the remote runner: the playbook's ANSIBLE_CONFIG
 * plus the package's vendored collections via ANSIBLE_COLLECTIONS_PATH.
 * @param {Object} playbook - Playbook entry
 * @param {string|null} provisioningBasePath - Staged package path
 * @returns {string} Env assignment prefix ('' when nothing applies)
 */
export const buildRemoteEnvPrefix = (playbook, provisioningBasePath) => {
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
export const installHostCollections = async (envPrefix, playbook, onData) => {
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
export const verboseFlag = playbook => {
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
export const prepareRemoteRun = async (zoneName, metadata) => {
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
