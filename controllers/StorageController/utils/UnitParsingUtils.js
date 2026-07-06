/**
 * @fileoverview Storage unit parsing utilities
 * @description Unit-string-to-bytes conversion and capacity calculation shared
 * by the storage parsers.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

/**
 * Parse unit string to bytes
 * @param {string} unitStr - String like "6.05G", "176G", "5.20M"
 * @returns {string|null} Bytes as string for large number storage
 */
export const parseUnitToBytes = unitStr => {
  if (!unitStr || unitStr === '-' || unitStr === 'none') {
    return null;
  }

  const match = unitStr.match(/^(?<number>[0-9.]+)(?<unit>[KMGTPEZ]?)$/i);
  if (!match) {
    return null;
  }

  const value = parseFloat(match.groups.number);
  const unit = match.groups.unit.toUpperCase();

  const multipliers = {
    '': 1,
    K: 1024,
    M: 1024 * 1024,
    G: 1024 * 1024 * 1024,
    T: 1024 * 1024 * 1024 * 1024,
    P: 1024 * 1024 * 1024 * 1024 * 1024,
    E: 1024 * 1024 * 1024 * 1024 * 1024 * 1024,
    Z: 1024 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024,
  };

  const multiplier = multipliers[unit] || 1;
  return Math.floor(value * multiplier).toString();
};

/**
 * Calculate capacity percentage
 * @param {string} allocBytes - Allocated bytes
 * @param {string} freeBytes - Free bytes
 * @returns {number|null} Capacity percentage
 */
export const calculateCapacity = (allocBytes, freeBytes) => {
  if (!allocBytes || !freeBytes) {
    return null;
  }

  const alloc = parseFloat(allocBytes);
  const free = parseFloat(freeBytes);
  const total = alloc + free;

  if (total === 0) {
    return 0;
  }
  return Math.round((alloc / total) * 100 * 100) / 100; // Round to 2 decimal places
};
