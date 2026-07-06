/**
 * @fileoverview Physical disk parsing utilities
 * @description Parser for `format` command output (disk inventory).
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { parseUnitToBytes } from './UnitParsingUtils.js';

/**
 * Parse disk format output to extract disk information
 * @param {string} output - Format command output
 * @param {string} hostname - Host name
 * @returns {Array} Parsed disk data
 */
export const parseFormatOutput = (output, hostname) => {
  const lines = output.trim().split('\n');
  const disks = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    // Match format: "0. c0t5F8DB4C101905B5Ad0 <ATA-PNY CS900 120GB-0613-111.79GB>"
    const match = trimmed.match(/^(?<index>\d+)\.\s+(?<device>\S+)\s+<(?<description>[^>]+)>/);
    if (match) {
      const { index, device: deviceName, description } = match.groups;
      const diskIndex = parseInt(index);

      // Extract serial number from device name (e.g., c0t5F8DB4C101905B5Ad0 -> 5F8DB4C101905B5A)
      const serialMatch = deviceName.match(/c\d+t(?<serial>[A-F0-9]+)d\d+$/i);
      const serialNumber = serialMatch ? serialMatch.groups.serial : null;

      // Parse description (e.g., "ATA-PNY CS900 120GB-0613-111.79GB")
      const descParts = description.split('-');
      let manufacturer = null;
      let model = null;
      let firmware = null;
      let capacity = null;
      let diskType = 'HDD'; // Default to HDD
      let interfaceType = 'UNKNOWN';

      if (descParts.length >= 3) {
        [manufacturer, model, firmware] = descParts;
        capacity = descParts[3] || null;

        // Determine disk type based on model/manufacturer
        const modelLower = model ? model.toLowerCase() : '';
        if (
          modelLower.includes('ssd') ||
          modelLower.includes('cs900') ||
          modelLower.includes('nvme') ||
          manufacturer === 'ATA'
        ) {
          diskType = 'SSD';
        }

        // Determine interface type
        if (manufacturer === 'ATA' || deviceName.includes('c1t')) {
          interfaceType = 'SATA';
        } else if (manufacturer === 'SEAGATE' || manufacturer === 'Hitachi') {
          interfaceType = 'SAS';
        }
      }

      // Parse capacity to bytes
      const capacityBytes = capacity ? parseUnitToBytes(capacity) : null;

      disks.push({
        host: hostname,
        disk_index: diskIndex,
        device_name: deviceName,
        serial_number: serialNumber,
        manufacturer,
        model,
        firmware,
        capacity,
        capacity_bytes: capacityBytes,
        device_path: null, // Will be populated if we can get it from format -e
        disk_type: diskType,
        interface_type: interfaceType,
        pool_assignment: null, // Will be determined by cross-referencing with zpool status
        is_available: true, // Will be updated based on pool assignment
        scan_timestamp: new Date(),
      });
    }
  }

  return disks;
};
