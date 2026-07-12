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
        removable: null, // Filled by the diskinfo truth pass
        scan_timestamp: new Date(),
      });
    }
  }

  return disks;
};

/**
 * Parse `diskinfo -cHp` output into inventory rows — the PRIMARY disk source.
 * Compact-parsable rows carry TYPE DISK VID PID SERIAL SIZE(bytes) FLRS
 * LOCATION(chassis,bay) per diskinfo(8)/diskinfo.c. PID may contain spaces,
 * so rows parse from both ends: TYPE/DISK/VID off the front,
 * LOCATION/FLRS/SIZE/SERIAL off the back, PID = the remainder. FLRS condenses
 * Faulty/Locate/Removable/SSD to one char each (letter = true, `-` = false,
 * `?` = unknown).
 * @param {string} output - diskinfo -cHp command output
 * @param {string} hostname - Host name
 * @returns {Array} Disk inventory rows
 */
export const parseDiskinfoInventory = (output, hostname) => {
  const disks = [];
  for (const line of output.trim().split('\n')) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 8) {
      continue;
    }
    const location = tokens[tokens.length - 1];
    const flrs = tokens[tokens.length - 2];
    const sizeBytes = tokens[tokens.length - 3];
    const serial = tokens[tokens.length - 4];
    if (!/^[A-Z?-]{4}$/.test(flrs) || !/^\d+$/.test(sizeBytes)) {
      continue;
    }
    const [interfaceType, deviceName, vid] = tokens;
    const pid = tokens.slice(3, tokens.length - 4).join(' ');

    let serialNumber = serial !== '-' ? serial : null;
    if (!serialNumber) {
      const serialFromName = deviceName.match(/c\d+t(?<serial>[A-F0-9]+)d\d+$/i);
      serialNumber = serialFromName ? serialFromName.groups.serial : null;
    }
    const locationMatch = location.match(/^(?<chassis>\d+),(?<bay>\d+)$/);
    const gib = Number(sizeBytes) / 1024 ** 3;

    disks.push({
      host: hostname,
      disk_index: disks.length,
      device_name: deviceName,
      serial_number: serialNumber,
      manufacturer: vid !== '-' ? vid : null,
      model: pid && pid !== '-' ? pid : null,
      firmware: null, // format enrichment fills this when available
      capacity: `${Math.round(gib * 100) / 100} GiB`,
      capacity_bytes: sizeBytes,
      device_path: null,
      disk_type: flrs.charAt(3) === 'S' ? 'SSD' : 'HDD',
      interface_type: interfaceType !== '-' ? interfaceType : null,
      pool_assignment: null, // zpool status cross-reference fills this
      is_available: true,
      removable: flrs.charAt(2) === 'R',
      faulty: flrs.charAt(0) === '?' ? null : flrs.charAt(0) === 'F',
      chassis: locationMatch ? parseInt(locationMatch.groups.chassis, 10) : null,
      bay: locationMatch ? parseInt(locationMatch.groups.bay, 10) : null,
      scan_timestamp: new Date(),
    });
  }
  return disks;
};

/**
 * Overlay `format` details onto diskinfo-sourced rows — best-effort
 * enrichment only (firmware + format's own disk numbering). Inventory
 * presence never depends on format succeeding: its interactive exit status
 * misbehaves under service users, which starved the inventory when it was
 * the primary source.
 * @param {Array} disks - parseDiskinfoInventory rows (mutated in place)
 * @param {string} formatOutput - format command output
 * @param {string} hostname - Host name
 * @returns {Array} The enriched rows
 */
export const applyFormatEnrichment = (disks, formatOutput, hostname) => {
  const formatRows = parseFormatOutput(formatOutput, hostname);
  const byDevice = new Map(formatRows.map(row => [row.device_name, row]));
  for (const disk of disks) {
    const row = byDevice.get(disk.device_name);
    if (!row) {
      continue;
    }
    disk.disk_index = row.disk_index;
    if (row.firmware) {
      disk.firmware = row.firmware;
    }
  }
  return disks;
};
