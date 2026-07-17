/**
 * @fileoverview Provisioner Configuration Builder for Zoneweaver Agent
 * @description Helper functions to build Ansible extra_vars from zone configuration
 *              matching the vagrant-zones Hosts.yml/Hosts.rb structure
 */

import fs from 'fs';
import yaml from 'js-yaml';
import { parseConfiguration } from './ZoneConfigUtils.js';
import { log } from './Logger.js';

/**
 * Load secrets from YAML files in provisioning dataset
 * Matches Hosts.rb load_secrets: loads secrets.yml then .secrets.yml (overrides)
 * API-provided secrets (provisioner.secrets) override file-based secrets
 *
 * @param {string} provisioningBasePath - Host path to provisioning dataset
 * @returns {Object} Merged secrets object
 */
export const loadSecretsFromFiles = provisioningBasePath => {
  if (!provisioningBasePath) {
    return {};
  }

  let secrets = {};

  const secretsPath = `${provisioningBasePath}/secrets.yml`;
  const hiddenSecretsPath = `${provisioningBasePath}/.secrets.yml`;

  if (fs.existsSync(secretsPath)) {
    try {
      const content = fs.readFileSync(secretsPath, 'utf8');
      const parsed = yaml.load(content);
      if (parsed && typeof parsed === 'object') {
        secrets = { ...secrets, ...parsed };
      }
      log.task.debug('Loaded secrets.yml', { path: secretsPath });
    } catch (e) {
      log.task.warn('Failed to load secrets.yml', { path: secretsPath, error: e.message });
    }
  }

  if (fs.existsSync(hiddenSecretsPath)) {
    try {
      const content = fs.readFileSync(hiddenSecretsPath, 'utf8');
      const parsed = yaml.load(content);
      if (parsed && typeof parsed === 'object') {
        secrets = { ...secrets, ...parsed };
      }
      log.task.debug('Loaded .secrets.yml', { path: hiddenSecretsPath });
    } catch (e) {
      log.task.warn('Failed to load .secrets.yml', { path: hiddenSecretsPath, error: e.message });
    }
  }

  return secrets;
};

/**
 * Build complete extra_vars object for Ansible playbooks
 * Matches the structure from vagrant-zones Hosts.rb (lines 517-533)
 *
 * @param {Object} zone - Zone database record with configuration
 * @param {Object} provisioner - Provisioner configuration object
 * @param {Object} options - Optional settings
 * @param {string} options.provisioningBasePath - Host path for loading secrets files
 * @returns {Object} Complete extra_vars object for Ansible
 */
export const buildExtraVarsFromZone = (zone, provisioner, options = {}) => {
  const zoneConfig = parseConfiguration(zone);

  // Extract sections from zone configuration
  const settings = zoneConfig.settings || {};
  const networks = zoneConfig.networks || [];
  const disks = zoneConfig.disks || {};

  // Extract sections from provisioner
  const roleVars = provisioner.vars || {};
  const provisionRoles = provisioner.roles || [];

  // Build complete extra_vars matching Hosts.rb structure
  const extraVars = {
    settings,
    networks,
    disks,
    secrets: {
      ...loadSecretsFromFiles(options.provisioningBasePath),
      ...(provisioner.secrets || {}),
    },
    role_vars: roleVars,
    provision_roles: provisionRoles,
    provision_pre_tasks: provisioner.pre_tasks || [],
    provision_post_tasks: provisioner.post_tasks || [],
    core_provisioner_version: provisioner.core_provisioner_version || '0.0.1',
    provisioner_name: provisioner.provisioner_name || 'zoneweaver',
    provisioner_version: provisioner.provisioner_version || '0.0.1',
  };

  log.task.debug('Built extra_vars for provisioning', {
    zone_name: zone.name,
    has_settings: !!settings && Object.keys(settings).length > 0,
    network_count: networks.length,
    has_disks: !!disks && Object.keys(disks).length > 0,
    role_vars_count: Object.keys(roleVars).length,
    provision_roles_count: provisionRoles.length,
  });

  return extraVars;
};

/**
 * Extract SSH credentials from settings object
 * Reads vagrant_user, vagrant_user_pass, and vagrant_user_private_key_path
 *
 * @param {Object} settings - Settings object from zone configuration
 * @returns {Object} Credentials object { username, password, ssh_key_path }
 */
export const extractCredentialsFromSettings = settings => {
  if (!settings) {
    log.task.warn('No settings provided for credential extraction');
    return {};
  }

  const credentials = {
    username: settings.vagrant_user || 'root',
  };

  if (settings.vagrant_user_pass) {
    credentials.password = settings.vagrant_user_pass;
  }

  if (settings.vagrant_user_private_key_path) {
    credentials.ssh_key_path = settings.vagrant_user_private_key_path;
  }

  log.task.debug('Extracted credentials from settings', {
    username: credentials.username,
    has_password: !!credentials.password,
    has_ssh_key: !!credentials.ssh_key_path,
  });

  return credentials;
};

/**
 * Extract control network IP address from networks array
 * Priority: is_control → provisional → first network
 *
 * @param {Array} networks - Networks array from zone configuration
 * @returns {string|null} Control network IP address or null
 */
export const extractControlIP = networks => {
  if (!networks || !Array.isArray(networks) || networks.length === 0) {
    log.task.warn('No networks array provided for IP extraction');
    return null;
  }

  // Find control network (is_control: true)
  const controlNetwork = networks.find(net => net.is_control === true);
  if (controlNetwork && controlNetwork.address) {
    log.task.debug('Found control network IP', { ip: controlNetwork.address });
    return controlNetwork.address;
  }

  // Fallback to provisional network
  const provisionalNetwork = networks.find(net => net.provisional === true);
  if (provisionalNetwork && provisionalNetwork.address) {
    log.task.debug('Found provisional network IP', { ip: provisionalNetwork.address });
    return provisionalNetwork.address;
  }

  // Fallback to first network with an address
  const firstNetwork = networks.find(net => net.address);
  if (firstNetwork && firstNetwork.address) {
    log.task.debug('Using first network IP', { ip: firstNetwork.address });
    return firstNetwork.address;
  }

  log.task.warn('No IP address found in networks array');
  return null;
};

/**
 * Extract EVERY playbook in the DOCUMENT'S OWN ORDER (Mark's ruling: the
 * provisioner document prescribes execution order — never "all locals then
 * all remotes"). provisioning.ansible.playbooks is a LIST of groups, each
 * carrying a `local:` and/or `remote:` key; Hosts.rb iterates the groups in
 * list order, so so do we. Each entry gains `mode: local|remote` from its
 * group key. Tolerated shapes (shared with the Go agent): the group LIST,
 * a single {local/remote} object, and the flat provisioners[] fallback
 * (mode local).
 * @param {Object} provisioner - Provisioner document
 * @returns {Array} Playbook configuration objects, document order, +mode
 */
export const extractOrderedPlaybooks = provisioner => {
  const ordered = [];
  const pushGroup = group => {
    if (!group || typeof group !== 'object') {
      return;
    }
    // Hosts.rb L502-586: within ONE group, the local block runs before the
    // remote block — fixed order, not YAML key order.
    for (const mode of ['local', 'remote']) {
      const entries = group[mode];
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (entry && typeof entry === 'object') {
            ordered.push({ ...entry, mode });
          }
        }
      }
    }
  };

  const playbooks = provisioner?.provisioning?.ansible?.playbooks;
  if (Array.isArray(playbooks)) {
    for (const group of playbooks) {
      pushGroup(group);
    }
  } else {
    pushGroup(playbooks);
  }
  if (ordered.length === 0 && Array.isArray(provisioner?.provisioners)) {
    for (const entry of provisioner.provisioners) {
      if (entry && typeof entry === 'object') {
        ordered.push({ ...entry, mode: 'local' });
      }
    }
  }
  return ordered;
};

/**
 * Bool vocabulary shared with the Go agent's method gates
 * (shell/ansible/docker `enabled`).
 * @param {*} value - Candidate
 * @returns {boolean} Whether it reads true
 */
export const readsTrue = value =>
  value === true || ['true', 'on', '1', 'yes'].includes(String(value).toLowerCase());

/**
 * Extract one docker method block's compose files (the document's shape:
 * `docker: {enabled, docker_compose: [files]}` — compose files nest INSIDE
 * docker; the hyphen-key spelling `docker-compose` is the accepted quirk).
 * A bare string entry prescribes exactly "run this" (Q3 ruling) — no
 * engine install, no run pin, nothing the document didn't say.
 * @param {Object} docker - The provisioning.docker block
 * @returns {Array<string>|null} Compose file paths in list order (null when off)
 */
export const extractDockerComposeFiles = docker => {
  if (!docker || !readsTrue(docker.enabled)) {
    return null;
  }
  const files = docker.docker_compose ?? docker['docker-compose'];
  if (!Array.isArray(files)) {
    return [];
  }
  return files.filter(entry => typeof entry === 'string' && entry.trim() !== '');
};

/**
 * Extract one phase's sequence hooks (provisioning-design §5):
 * provisioning.pre[] / provisioning.post[], entries {script, target:
 * host|guest, on_failure: abort|continue, run: always|once}. Defaults:
 * target guest, on_failure abort, run always.
 * @param {Object} provisioner - Provisioner document
 * @param {string} phase - 'pre' | 'post'
 * @returns {Array<Object>} Normalized hook entries in list order
 */
export const extractHooks = (provisioner, phase) => {
  const entries = provisioner?.provisioning?.[phase];
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .filter(entry => entry && typeof entry.script === 'string' && entry.script.trim() !== '')
    .map(entry => ({
      script: entry.script,
      target: entry.target === 'host' ? 'host' : 'guest',
      on_failure: entry.on_failure === 'continue' ? 'continue' : 'abort',
      run: entry.run === 'once' ? 'once' : 'always',
    }));
};

/**
 * The document's global vars as the script/hook environment
 * (provisioning-design §5 vars→env): EVERY key rides under its EXACT name,
 * no prefix, never filtered here (the vars ride WHOLE — extended ruling);
 * lists/dicts as JSON strings (the ruled encoding). Names env(1) cannot
 * carry are narrated-and-skipped by the EXECUTOR at run time, loudly.
 * @param {Object} provisioner - Provisioner document
 * @returns {Object} Environment map (string values, all keys)
 */
export const buildScriptEnv = provisioner => {
  const vars = provisioner?.vars;
  const env = {};
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
    return env;
  }
  for (const [key, value] of Object.entries(vars)) {
    if (value === null || value === undefined) {
      env[key] = '';
    } else if (typeof value === 'object') {
      env[key] = JSON.stringify(value);
    } else {
      env[key] = String(value);
    }
  }
  return env;
};

/**
 * Extract the sync folders from a provisioner document (folders, falling back
 * to sync_folders).
 * @param {Object} provisioner - Provisioner document
 * @returns {Array} Folder configuration objects
 */
export const extractFolders = provisioner => {
  if (Array.isArray(provisioner?.folders)) {
    return provisioner.folders;
  }
  if (Array.isArray(provisioner?.sync_folders)) {
    return provisioner.sync_folders;
  }
  return [];
};

/**
 * Extract one shell method block's scripts (`shell: {enabled, scripts[]}` —
 * package-relative path strings in LIST ORDER). A bare string prescribes
 * exactly "run this" (Q3 ruling): it runs whenever the walk reaches it.
 * @param {Object} shell - The provisioning.shell block
 * @returns {Array<string>|null} Script paths in list order (null when off)
 */
export const extractShellScripts = shell => {
  if (!shell || !readsTrue(shell.enabled) || !Array.isArray(shell.scripts)) {
    return null;
  }
  return shell.scripts.filter(script => typeof script === 'string' && script.trim() !== '');
};

/**
 * Build playbook-specific extra_vars
 * Merges base extra_vars with playbook-specific collections and settings
 *
 * @param {Object} baseExtraVars - Base extra_vars from buildExtraVarsFromZone
 * @param {Object} playbook - Playbook configuration object
 * @returns {Object} Complete extra_vars for this specific playbook
 */
export const buildPlaybookExtraVars = (baseExtraVars, playbook) => {
  const playbookExtraVars = { ...baseExtraVars };

  // Add playbook-specific collections
  if (playbook.collections) {
    playbookExtraVars.playbook_collections = playbook.collections;
  }

  // Add Ansible configuration from playbook
  if (playbook.callbacks) {
    playbookExtraVars.ansible_callbacks_enabled = playbook.callbacks;
  }

  if (playbook.ssh_pipelining !== undefined) {
    playbookExtraVars.ansible_ssh_pipelining = playbook.ssh_pipelining;
  }

  if (playbook.ansible_python_interpreter) {
    playbookExtraVars.ansible_python_interpreter = playbook.ansible_python_interpreter;
  }

  return playbookExtraVars;
};
