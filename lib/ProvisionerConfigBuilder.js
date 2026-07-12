/**
 * @fileoverview Provisioner Configuration Builder for Zoneweaver Agent
 * @description Helper functions to build Ansible extra_vars from zone configuration
 *              matching the vagrant-zones Hosts.yml/Hosts.rb structure
 */

import fs from 'fs';
import yaml from 'js-yaml';
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
  let zoneConfig = zone.configuration;
  if (typeof zoneConfig === 'string') {
    try {
      zoneConfig = JSON.parse(zoneConfig);
    } catch (e) {
      log.task.warn('Failed to parse zone configuration', { error: e.message });
      zoneConfig = {};
    }
  }

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
 * Extract the local playbooks from a provisioner document — BOTH real-world
 * shapes (shared tolerance with the Go agent): provisioning.ansible.playbooks
 * as an object ({local: []}) and as a LIST of {local: []} groups (the package
 * templates and Hosts.rb's own iteration), falling back to a flat
 * provisioners[] list.
 * @param {Object} provisioner - Provisioner document
 * @returns {Array} Playbook configuration objects
 */
export const extractPlaybooks = provisioner => {
  let raw = [];
  const playbooks = provisioner?.provisioning?.ansible?.playbooks;
  if (Array.isArray(playbooks)) {
    for (const group of playbooks) {
      if (Array.isArray(group?.local)) {
        raw = raw.concat(group.local);
      }
    }
  } else if (Array.isArray(playbooks?.local)) {
    raw = playbooks.local;
  }
  if (raw.length === 0 && Array.isArray(provisioner?.provisioners)) {
    raw = provisioner.provisioners;
  }
  return raw;
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
