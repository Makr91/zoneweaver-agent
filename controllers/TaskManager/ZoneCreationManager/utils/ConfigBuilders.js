import config from '../../../../config/ConfigLoader.js';
import { buildCpuValue } from '../../../../lib/ZoneConfigUtils.js';

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
  const paddedId = String(serverId || '').padStart(4, '0');
  if (zonesConfig.prefix_datasets && serverId && !zoneName.startsWith(paddedId)) {
    return `${basePath}/${paddedId}--${zoneName}`;
  }
  return `${basePath}/${zoneName}`;
};

/**
 * The applied boot ROM when zones.bootrom is absent: settings.firmware_type
 * BIOS maps to the CSM ROM (genuine legacy guests); everything else gets the
 * UEFI firmware — modern templates boot UEFI, and the VNC framebuffer only
 * works on UEFI-booted guests (CSM boots give a black console). The bhyve
 * brand's own unset-attr default (BHYVE_RELEASE_CSM) is deliberately not
 * inherited.
 * @param {Object} settings - Document settings section
 * @returns {string} Boot ROM name
 */
const bhyveBootromDefault = settings =>
  String(settings.firmware_type || '').toUpperCase() === 'BIOS'
    ? 'BHYVE_RELEASE_CSM'
    : 'BHYVE_RELEASE';

/**
 * Build zone attribute map from metadata (supports both old and new structures)
 * @param {Object} metadata - Zone creation metadata
 * @returns {Object} Attribute map
 */
export const buildZoneAttributeMap = metadata => {
  const zones = metadata.zones || {};
  const settings = metadata.settings || {};
  const brand = zones.brand || metadata.brand;
  return {
    ram: settings.memory || metadata.ram,
    // Create wire spelling: zones.cpu_configuration / zones.complex_cpu_conf
    // (the modify wire carries the same keys top-level) — ONE shared builder.
    vcpus: buildCpuValue(
      zones.cpu_configuration,
      zones.complex_cpu_conf,
      settings.vcpus || metadata.vcpus
    ),
    bootrom:
      zones.bootrom ||
      metadata.bootrom ||
      (brand === 'bhyve' ? bhyveBootromDefault(settings) : undefined),
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
