/**
 * @fileoverview ZFS dataset parsing utilities
 * @description Parsers for zfs list and zfs get all output.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { parseUnitToBytes } from './UnitParsingUtils.js';

/**
 * Parse zfs list output
 * @param {string} output - Command output
 * @param {string} hostname - Host name
 * @returns {Array} Parsed dataset data
 */
export const parseDatasetListOutput = (output, hostname) => {
  const lines = output.trim().split('\n');
  const datasets = [];

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    const parts = line.split(/\s+/);
    if (parts.length >= 5) {
      const poolMatch = parts[0].match(/^(?<pool>[^/]+)/);
      const pool = poolMatch ? poolMatch.groups.pool : null;

      datasets.push({
        host: hostname,
        name: parts[0],
        pool,
        used: parts[1],
        used_bytes: parseUnitToBytes(parts[1]),
        available: parts[2],
        available_bytes: parseUnitToBytes(parts[2]),
        referenced: parts[3],
        referenced_bytes: parseUnitToBytes(parts[3]),
        mountpoint: parts[4],
        scan_timestamp: new Date(),
      });
    }
  }

  return datasets;
};

/**
 * Map ZFS property to dataset model field
 * @param {string} property - ZFS property name
 * @param {string|Array<string>} value - Property value or parts array
 * @param {Object} properties - Properties object to update
 */
const mapZFSProperty = (property, value, properties) => {
  const propertyValue = Array.isArray(value) ? value[0] : value;

  switch (property) {
    case 'type':
      properties.type = propertyValue;
      break;
    case 'creation':
      properties.creation = Array.isArray(value) ? value.join(' ') : propertyValue;
      break;
    case 'used':
      properties.used = propertyValue;
      properties.used_bytes = parseUnitToBytes(propertyValue);
      break;
    case 'available':
      properties.available = propertyValue;
      properties.available_bytes = parseUnitToBytes(propertyValue);
      break;
    case 'referenced':
      properties.referenced = propertyValue;
      properties.referenced_bytes = parseUnitToBytes(propertyValue);
      break;
    case 'compressratio':
      properties.compressratio = propertyValue;
      break;
    case 'reservation':
      properties.reservation = propertyValue;
      break;
    case 'volsize':
      properties.volsize = propertyValue;
      break;
    case 'volblocksize':
      properties.volblocksize = propertyValue;
      break;
    case 'checksum':
      properties.checksum = propertyValue;
      break;
    case 'compression':
      properties.compression = propertyValue;
      break;
    case 'readonly':
      properties.readonly = propertyValue;
      break;
    case 'copies':
      properties.copies = propertyValue;
      break;
    case 'guid':
      properties.guid = propertyValue;
      break;
    case 'usedbysnapshots':
      properties.usedbysnapshots = propertyValue;
      break;
    case 'usedbydataset':
      properties.usedbydataset = propertyValue;
      break;
    case 'usedbychildren':
      properties.usedbychildren = propertyValue;
      break;
    case 'logicalused':
      properties.logicalused = propertyValue;
      break;
    case 'logicalreferenced':
      properties.logicalreferenced = propertyValue;
      break;
    case 'written':
      properties.written = propertyValue;
      break;
    case 'mountpoint':
      properties.mountpoint = propertyValue;
      break;
    case 'mounted':
      properties.mounted = propertyValue;
      break;
  }
};

/**
 * Parse zfs get all output
 * @param {string} output - Command output
 * @param {string} datasetName - Dataset name being queried
 * @param {string} hostname - Host name
 * @returns {Object} Parsed dataset properties
 */
export const parseDatasetPropertiesOutput = (output, datasetName, hostname) => {
  const lines = output.trim().split('\n');
  const properties = {
    host: hostname,
    name: datasetName,
    scan_timestamp: new Date(),
  };

  // Extract pool name from dataset name
  const poolMatch = datasetName.match(/^(?<pool>[^/]+)/);
  if (poolMatch) {
    properties.pool = poolMatch.groups.pool;
  }

  for (let i = 1; i < lines.length; i++) {
    // Skip header
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    const parts = line.split(/\s+/);
    if (parts.length >= 3) {
      const [, property, value] = parts;
      const remainingParts = parts.slice(2);

      // Map ZFS properties to our model fields
      mapZFSProperty(property, property === 'creation' ? remainingParts : value, properties);
    }
  }

  return properties;
};
