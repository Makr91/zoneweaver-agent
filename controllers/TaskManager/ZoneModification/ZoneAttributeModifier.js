/**
 * @fileoverview Zone Attribute Modifier for Zone Configuration Changes
 * @description Handles simple attribute, autoboot, and cloud-init modifications via zonecfg
 */

import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import { buildCpuValue } from '../../../lib/ZoneConfigUtils.js';
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
 * Apply simple attribute modifications (ram, vcpus, etc.)
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Object} metadata - Modification metadata
 */
const applyAttributeChanges = async (zoneName, zoneConfig, metadata, onData = null) => {
  const attrMap = {
    ram: metadata.ram,
    // Modify wire spelling: cpu_configuration/complex_cpu_conf/vcpus at the
    // TOP level (PUT /machines/{name} contract) — ONE shared builder; an
    // absent request yields undefined and the filter below drops the attr.
    vcpus: buildCpuValue(metadata.cpu_configuration, metadata.complex_cpu_conf, metadata.vcpus),
    bootrom: metadata.bootrom,
    hostbridge: metadata.hostbridge,
    diskif: metadata.diskif,
    netif: metadata.netif,
    type: metadata.os_type,
    vnc: metadata.vnc,
    acpi: metadata.acpi,
    xhci: metadata.xhci,
    uefivars: metadata.uefivars,
    rng: metadata.rng,
    bootorder: metadata.bootorder,
    bootnext: metadata.bootnext,
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
    'cpu_configuration',
    'bootrom',
    'hostbridge',
    'diskif',
    'netif',
    'os_type',
    'vnc',
    'acpi',
    'xhci',
    'uefivars',
    'rng',
    'bootorder',
    'bootnext',
  ].some(key => metadata[key] !== undefined);

  if (hasAttrChanges) {
    await updateTaskProgress(task, 20, { status: 'modifying_attributes' });
    await applyAttributeChanges(zoneName, zoneConfig, metadata, onData);
    changes.push('attributes');
  }
};
