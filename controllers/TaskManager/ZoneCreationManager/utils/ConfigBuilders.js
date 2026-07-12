import config from '../../../../config/ConfigLoader.js';

/**
 * @fileoverview Zone configuration builder utilities
 */

/**
 * Build a zonecfg attribute command string
 * Values are quoted to handle spaces and special characters
 * @param {string} name - Attribute name
 * @param {string} value - Attribute value
 * @returns {string} zonecfg add attr command
 */
export const buildAttrCommand = (name, value) =>
  `add attr; set name=${name}; set value=\\"${value}\\"; set type=string; end;`;

/**
 * Build dataset path with server_id prefix if enabled
 * @param {string} basePath - Base dataset path
 * @param {string} zoneName - Zone name (may already include server prefix)
 * @param {string} serverId - Server ID
 * @returns {string} Full dataset path
 */
export const buildDatasetPath = (basePath, zoneName, serverId) => {
  const zonesConfig = config.getZones();
  const paddedId = serverId.padStart(4, '0');
  if (zonesConfig.prefix_datasets && serverId && !zoneName.startsWith(paddedId)) {
    return `${basePath}/${paddedId}--${zoneName}`;
  }
  return `${basePath}/${zoneName}`;
};

/**
 * Build CPU configuration value for bhyve (simple or complex topology)
 * Format: [[cpus=]numcpus][,sockets=n][,cores=n][,threads=n]
 * @param {Object} metadata - Zone creation metadata
 * @returns {string|number} CPU configuration value
 */
export const buildCpuValue = metadata => {
  const zones = metadata.zones || {};
  const settings = metadata.settings || {};
  const vcpus = settings.vcpus || metadata.vcpus;

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
 * Build zone attribute map from metadata (supports both old and new structures)
 * @param {Object} metadata - Zone creation metadata
 * @returns {Object} Attribute map
 */
export const buildZoneAttributeMap = metadata => {
  const zones = metadata.zones || {};
  const settings = metadata.settings || {};
  return {
    ram: settings.memory || metadata.ram,
    vcpus: buildCpuValue(metadata),
    bootrom: zones.bootrom || metadata.bootrom,
    hostbridge: zones.hostbridge || metadata.hostbridge,
    diskif: zones.diskif || metadata.diskif,
    netif: zones.netif || metadata.netif,
    type: settings.os_type || metadata.os_type,
    vnc: zones.vnc || metadata.vnc,
    acpi: zones.acpi || metadata.acpi,
    xhci: zones.xhci || metadata.xhci,
    bootorder: zones.bootorder || metadata.bootorder,
    bootnext: zones.bootnext || metadata.bootnext,
    // Agent-owned custom attrs: create materializes the document inputs into
    // zonecfg so the value rides the zone (the PUT knobs edit the same attrs).
    boot_priority: zones.boot_priority,
    consoleport: settings.consoleport,
    consolehost: settings.consolehost,
  };
};
