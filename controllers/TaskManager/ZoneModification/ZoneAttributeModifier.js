/**
 * @fileoverview Zone Attribute Modifier for Zone Configuration Changes
 * @description Handles simple attribute, autoboot, and cloud-init modifications via zonecfg
 */

import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import { updateTaskProgress } from '../../../lib/TaskProgressHelper.js';

/**
 * Check if a named attribute exists in zone configuration
 * @param {Object} zoneConfig - Zone configuration from zadm show
 * @param {string} attrName - Attribute name to check
 * @returns {boolean} True if attribute exists
 */
const hasAttribute = (zoneConfig, attrName) => {
  // Check top-level properties (zadm normalizes some attrs)
  if (zoneConfig[attrName] !== undefined) {
    return true;
  }

  // Check attr array
  if (Array.isArray(zoneConfig.attr)) {
    return zoneConfig.attr.some(a => a.name === attrName);
  }

  return false;
};

/**
 * Build zonecfg command to add or update an attribute
 * @param {Object} zoneConfig - Current zone configuration
 * @param {string} attrName - Attribute name
 * @param {string} value - Attribute value
 * @returns {string} zonecfg command string
 */
const buildSetAttrCommand = (zoneConfig, attrName, value) => {
  if (hasAttribute(zoneConfig, attrName)) {
    return `select attr name=${attrName}; set value=\\"${value}\\"; end;`;
  }
  return `add attr; set name=${attrName}; set value=\\"${value}\\"; set type=string; end;`;
};

/**
 * Build CPU configuration value for bhyve (simple or complex topology)
 * Format: [[cpus=]numcpus][,sockets=n][,cores=n][,threads=n]
 * @param {Object} metadata - Modification metadata
 * @returns {string|number|undefined} CPU configuration value
 */
const buildCpuValue = metadata => {
  const zones = metadata.zones || {};
  const vcpus = metadata.vcpus || metadata.settings?.vcpus;

  // No vcpu change requested
  if (!vcpus && !zones.cpu_configuration) {
    return undefined;
  }

  // Simple mode (default)
  if (!zones.cpu_configuration || zones.cpu_configuration === 'simple') {
    return vcpus;
  }

  // Complex mode - build topology string
  if (zones.cpu_configuration === 'complex') {
    const cpuConf = zones.complex_cpu_conf;

    if (!cpuConf || cpuConf.length === 0) {
      throw new Error('complex_cpu_conf required when cpu_configuration is "complex"');
    }

    const [conf] = cpuConf;
    const { sockets, cores, threads } = conf;

    // Validation
    if (!sockets || !cores || !threads) {
      throw new Error('complex_cpu_conf must specify sockets, cores, and threads');
    }

    if (sockets < 1 || cores < 1 || threads < 1) {
      throw new Error('sockets, cores, and threads must be >= 1');
    }

    if (sockets > 16) {
      throw new Error('sockets must be <= 16 (bhyve limit)');
    }

    if (cores > 32) {
      throw new Error('cores must be <= 32 (bhyve limit)');
    }

    if (threads > 2) {
      throw new Error('threads must be <= 2 (SMT limit)');
    }

    const total = sockets * cores * threads;
    if (total > 32) {
      throw new Error(`Total vCPUs (${total}) exceeds bhyve maximum of 32`);
    }

    // Build topology string
    return `sockets=${sockets},cores=${cores},threads=${threads}`;
  }

  // Invalid configuration
  throw new Error(
    `Invalid cpu_configuration: ${zones.cpu_configuration}. Must be "simple" or "complex"`
  );
};

/**
 * Apply simple attribute modifications (ram, vcpus, etc.)
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Object} metadata - Modification metadata
 */
const applyAttributeChanges = async (zoneName, zoneConfig, metadata, onData = null) => {
  const attrMap = {
    ram: metadata.ram,
    vcpus: buildCpuValue(metadata),
    bootrom: metadata.bootrom,
    hostbridge: metadata.hostbridge,
    diskif: metadata.diskif,
    netif: metadata.netif,
    type: metadata.os_type,
    vnc: metadata.vnc,
    acpi: metadata.acpi,
    xhci: metadata.xhci,
  };

  const commands = Object.entries(attrMap)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => buildSetAttrCommand(zoneConfig, name, value));

  if (commands.length === 0) {
    return;
  }

  const attrCmd = `pfexec zonecfg -z ${zoneName} "${commands.join(' ')}"`;
  const attrResult = await executeCommand(attrCmd, undefined, onData);
  if (!attrResult.success) {
    throw new Error(`Attribute modification failed: ${attrResult.error}`);
  }

  log.task.info('Applied attribute changes', {
    zone_name: zoneName,
    attributes: Object.keys(attrMap).filter(k => attrMap[k] !== undefined && attrMap[k] !== null),
  });
};

/**
 * Apply autoboot change
 * @param {string} zoneName - Zone name
 * @param {boolean} autoboot - Autoboot setting
 */
export const applyAutobootChange = async (zoneName, autoboot, onData = null) => {
  const value = autoboot ? 'true' : 'false';
  const autobootResult = await executeCommand(
    `pfexec zonecfg -z ${zoneName} "set autoboot=${value}"`,
    undefined,
    onData
  );
  if (!autobootResult.success) {
    throw new Error(`Autoboot modification failed: ${autobootResult.error}`);
  }

  log.task.info('Applied autoboot change', { zone_name: zoneName, autoboot: value });
};

/**
 * Apply cloud-init attribute changes
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Object} cloudInit - Cloud-init configuration
 */
export const applyCloudInitChanges = async (zoneName, zoneConfig, cloudInit, onData = null) => {
  const commands = [];

  if (cloudInit.enabled !== undefined) {
    commands.push(buildSetAttrCommand(zoneConfig, 'cloud-init', cloudInit.enabled));
  }
  if (cloudInit.dns_domain !== undefined) {
    commands.push(buildSetAttrCommand(zoneConfig, 'dns-domain', cloudInit.dns_domain));
  }
  if (cloudInit.password !== undefined) {
    commands.push(buildSetAttrCommand(zoneConfig, 'password', cloudInit.password));
  }
  if (cloudInit.resolvers !== undefined) {
    commands.push(buildSetAttrCommand(zoneConfig, 'resolvers', cloudInit.resolvers));
  }
  if (cloudInit.sshkey !== undefined) {
    commands.push(buildSetAttrCommand(zoneConfig, 'sshkey', cloudInit.sshkey));
  }

  if (commands.length > 0) {
    const cloudCmd = `pfexec zonecfg -z ${zoneName} "${commands.join(' ')}"`;
    const cloudResult = await executeCommand(cloudCmd, undefined, onData);
    if (!cloudResult.success) {
      throw new Error(`Cloud-init modification failed: ${cloudResult.error}`);
    }

    log.task.info('Applied cloud-init changes', { zone_name: zoneName });
  }
};

/**
 * Apply attribute changes if needed
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Object} metadata - Modification metadata
 * @param {Object} task - Task object
 * @param {Array} changes - Changes array to update
 * @returns {Promise<void>}
 */
export const applyAttributeChangesIfNeeded = async (
  zoneName,
  zoneConfig,
  metadata,
  task,
  changes,
  onData = null
) => {
  const hasAttrChanges = [
    'ram',
    'vcpus',
    'bootrom',
    'hostbridge',
    'diskif',
    'netif',
    'os_type',
    'vnc',
    'acpi',
    'xhci',
  ].some(key => metadata[key] !== undefined);

  if (hasAttrChanges) {
    await updateTaskProgress(task, 20, { status: 'modifying_attributes' });
    await applyAttributeChanges(zoneName, zoneConfig, metadata, onData);
    changes.push('attributes');
  }
};
