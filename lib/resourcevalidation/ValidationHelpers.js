/**
 * @fileoverview Resource Validation Shared Helpers
 * @description Byte formatting and zone configuration parsing shared by the
 *              storage, memory, and CPU resource validators.
 */

/**
 * Format bytes as human-readable string
 * @param {number} bytes - Byte count
 * @returns {string} Human-readable size (e.g., "48.0G")
 */
export const formatBytes = bytes => {
  if (bytes >= 1024 ** 4) {
    return `${(bytes / 1024 ** 4).toFixed(1)}T`;
  }
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)}M`;
  }
  return `${bytes}B`;
};

// ─── Shared Helpers ─────────────────────────────────────────────────────────

/**
 * Safely parse zone configuration from DB record
 * @param {Object} zone - Zone model instance
 * @returns {Object|null} Parsed configuration or null
 */
export const parseZoneConfig = zone => {
  const cfg = zone.configuration;
  if (!cfg) {
    return null;
  }
  if (typeof cfg === 'string') {
    try {
      return JSON.parse(cfg);
    } catch {
      return null;
    }
  }
  return cfg;
};
