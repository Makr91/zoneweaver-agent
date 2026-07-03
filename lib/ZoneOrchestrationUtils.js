/**
 * @fileoverview Zone Orchestration Utilities
 * @description Helper functions for zone priority orchestration (read-only)
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { log } from './Logger.js';

/**
 * Extract priority from zone configuration attr array
 * @param {Object} zoneConfig - Zone configuration from zadm show
 * @returns {number} Priority value (1-100, default 95)
 */
export const extractZonePriority = zoneConfig => {
  try {
    if (!zoneConfig?.attr || !Array.isArray(zoneConfig.attr)) {
      return 95; // Default high priority if no attributes
    }

    // Look for boot_priority attribute
    const priorityAttr = zoneConfig.attr.find(
      attr => attr.name === 'boot_priority' || attr.name === 'shutdown_priority'
    );

    if (priorityAttr) {
      const priority = parseInt(priorityAttr.value);
      if (!isNaN(priority) && priority >= 1 && priority <= 100) {
        return priority;
      }
    }

    // Default to high priority (infrastructure) if no valid priority set
    return 95;
  } catch (error) {
    log.monitoring.warn('Error extracting zone priority from config', {
      zone_name: zoneConfig?.zonename || 'unknown',
      error: error.message,
    });
    return 95; // Safe default
  }
};

/**
 * Group zones by priority ranges for orchestration
 * @param {Array} zones - Array of zone objects with config
 * @returns {Array} Array of priority groups, sorted for shutdown order
 */
export const groupZonesByPriority = zones => {
  const priorityGroups = new Map();

  // Group zones by priority ranges (10s: 1-10, 20s: 11-20, etc.)
  zones.forEach(zone => {
    const priority = extractZonePriority(zone.configuration);
    const priorityGroup = Math.floor((priority - 1) / 10) * 10 + 10; // Round up to nearest 10

    if (!priorityGroups.has(priorityGroup)) {
      priorityGroups.set(priorityGroup, []);
    }

    priorityGroups.get(priorityGroup).push({
      name: zone.name,
      priority,
      state: zone.status,
      configuration: zone.configuration,
    });
  });

  // Convert to sorted array (lowest priority first for shutdown)
  return Array.from(priorityGroups.entries())
    .sort(([a], [b]) => a - b)
    .map(([priority, zoneList]) => ({
      priority_range: priority,
      zones: zoneList.sort((a, b) => a.priority - b.priority), // Sort within group
    }));
};

/**
 * Calculate shutdown order (lowest priority first)
 * @param {Array} zones - Array of zones with configuration
 * @returns {Array} Zones ordered for shutdown (development → applications → infrastructure)
 */
export const calculateShutdownOrder = zones => {
  const groups = groupZonesByPriority(zones);

  log.monitoring.info('Calculated zone shutdown order', {
    total_zones: zones.length,
    priority_groups: groups.length,
    groups: groups.map(g => ({
      priority_range: g.priority_range,
      zone_count: g.zones.length,
      zones: g.zones.map(z => z.name),
    })),
  });

  return groups; // Already sorted lowest first
};

/**
 * Calculate startup order (highest priority first)
 * @param {Array} zones - Array of zones with configuration
 * @returns {Array} Zones ordered for startup (infrastructure → applications → development)
 */
export const calculateStartupOrder = zones => {
  const groups = groupZonesByPriority(zones);

  // Reverse order for startup (highest priority first)
  const startupGroups = groups.reverse();

  log.monitoring.info('Calculated zone startup order', {
    total_zones: zones.length,
    priority_groups: startupGroups.length,
    groups: startupGroups.map(g => ({
      priority_range: g.priority_range,
      zone_count: g.zones.length,
      zones: g.zones.map(z => z.name),
    })),
  });

  return startupGroups;
};

/**
 * Get zone priority from existing zone data (reuses existing API calls)
 * @param {string} zoneName - Zone name
 * @param {Object} existingConfig - Zone config from existing zadm show call
 * @returns {number} Priority value
 */
export const getZonePriorityFromConfig = (zoneName, existingConfig) => {
  const priority = extractZonePriority(existingConfig);

  log.monitoring.debug('Zone priority extracted', {
    zone_name: zoneName,
    priority,
    has_custom_priority: priority !== 95,
  });

  return priority;
};

/**
 * Validate orchestration strategy
 * @param {string} strategy - Orchestration strategy
 * @returns {{valid: boolean, error?: string}}
 */
export const validateOrchestrationStrategy = strategy => {
  const validStrategies = ['sequential', 'parallel_by_priority', 'staggered'];

  if (!strategy) {
    return { valid: true }; // Will use default
  }

  if (!validStrategies.includes(strategy)) {
    return {
      valid: false,
      error: `Invalid strategy '${strategy}'. Valid options: ${validStrategies.join(', ')}`,
    };
  }

  return { valid: true };
};

/**
 * Validate orchestration timeouts
 * @param {Object} timeouts - Timeout configuration
 * @returns {{valid: boolean, error?: string}}
 */
export const validateOrchestrationTimeouts = timeouts => {
  if (!timeouts) {
    return { valid: true };
  }

  const { zone_timeout, total_timeout, priority_delay } = timeouts;

  if (zone_timeout !== undefined) {
    if (zone_timeout < 10 || zone_timeout > 3600) {
      return { valid: false, error: 'zone_timeout must be between 10 and 3600 seconds' };
    }
  }

  if (total_timeout !== undefined) {
    if (total_timeout < 60 || total_timeout > 7200) {
      return { valid: false, error: 'total_timeout must be between 60 and 7200 seconds' };
    }
  }

  if (priority_delay !== undefined) {
    if (priority_delay < 0 || priority_delay > 300) {
      return { valid: false, error: 'priority_delay must be between 0 and 300 seconds' };
    }
  }

  return { valid: true };
};
