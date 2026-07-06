/**
 * @fileoverview ZFS ARC parsing utilities
 * @description Parser for kstat arcstats output including efficiency metrics.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

/**
 * Map ARC size properties
 * @param {string} property - Property name
 * @param {string} value - Property value
 * @param {Object} arcStats - ARC stats object
 * @returns {boolean} Whether property was mapped
 */
const mapARCSizeProperties = (property, value, arcStats) => {
  switch (property) {
    case 'size':
      arcStats.arc_size = value;
      return true;
    case 'c':
      arcStats.arc_target_size = value;
      return true;
    case 'c_min':
      arcStats.arc_min_size = value;
      return true;
    case 'c_max':
      arcStats.arc_max_size = value;
      return true;
    case 'arc_meta_used':
      arcStats.arc_meta_used = value;
      return true;
    case 'arc_meta_limit':
      arcStats.arc_meta_limit = value;
      return true;
    case 'mru_size':
      arcStats.mru_size = value;
      return true;
    case 'mfu_size':
      arcStats.mfu_size = value;
      return true;
    case 'data_size':
      arcStats.data_size = value;
      return true;
    case 'metadata_size':
      arcStats.metadata_size = value;
      return true;
    default:
      return false;
  }
};

/**
 * Map ARC hit/miss statistics
 * @param {string} property - Property name
 * @param {string} value - Property value
 * @param {Object} arcStats - ARC stats object
 * @returns {boolean} Whether property was mapped
 */
const mapARCHitMissProperties = (property, value, arcStats) => {
  switch (property) {
    case 'hits':
      arcStats.hits = value;
      return true;
    case 'misses':
      arcStats.misses = value;
      return true;
    case 'demand_data_hits':
      arcStats.demand_data_hits = value;
      return true;
    case 'demand_data_misses':
      arcStats.demand_data_misses = value;
      return true;
    case 'demand_metadata_hits':
      arcStats.demand_metadata_hits = value;
      return true;
    case 'demand_metadata_misses':
      arcStats.demand_metadata_misses = value;
      return true;
    case 'prefetch_data_hits':
      arcStats.prefetch_data_hits = value;
      return true;
    case 'prefetch_data_misses':
      arcStats.prefetch_data_misses = value;
      return true;
    case 'mru_hits':
      arcStats.mru_hits = value;
      return true;
    case 'mfu_hits':
      arcStats.mfu_hits = value;
      return true;
    case 'mru_ghost_hits':
      arcStats.mru_ghost_hits = value;
      return true;
    case 'mfu_ghost_hits':
      arcStats.mfu_ghost_hits = value;
      return true;
    default:
      return false;
  }
};

/**
 * Map ARC miscellaneous properties
 * @param {string} property - Property name
 * @param {string} value - Property value
 * @param {Object} arcStats - ARC stats object
 * @returns {boolean} Whether property was mapped
 */
const mapARCMiscProperties = (property, value, arcStats) => {
  switch (property) {
    case 'p':
      arcStats.arc_p = value;
      return true;
    case 'compressed_size':
      arcStats.compressed_size = value;
      return true;
    case 'uncompressed_size':
      arcStats.uncompressed_size = value;
      return true;
    case 'l2_size':
      arcStats.l2_size = value;
      return true;
    case 'l2_hits':
      arcStats.l2_hits = value;
      return true;
    case 'l2_misses':
      arcStats.l2_misses = value;
      return true;
    default:
      return false;
  }
};

/**
 * Map kstat ARC property to model field
 * @param {string} property - Kstat property name
 * @param {string} value - Property value
 * @param {Object} arcStats - ARC stats object to update
 */
const mapARCProperty = (property, value, arcStats) => {
  // Try mapping in order of likelihood to reduce checks
  if (mapARCHitMissProperties(property, value, arcStats)) {
    return;
  }
  if (mapARCSizeProperties(property, value, arcStats)) {
    return;
  }
  mapARCMiscProperties(property, value, arcStats);
};

/**
 * Calculate ARC efficiency metrics
 * @param {Object} arcStats - ARC stats object to update with efficiency metrics
 */
const calculateARCEfficiency = arcStats => {
  // Calculate efficiency metrics
  if (arcStats.hits && arcStats.misses) {
    const totalAccess = parseInt(arcStats.hits) + parseInt(arcStats.misses);
    if (totalAccess > 0) {
      arcStats.hit_ratio = ((parseInt(arcStats.hits) / totalAccess) * 100).toFixed(2);
    }
  }

  if (arcStats.demand_data_hits && arcStats.demand_data_misses) {
    const totalDemandData =
      parseInt(arcStats.demand_data_hits) + parseInt(arcStats.demand_data_misses);
    if (totalDemandData > 0) {
      arcStats.data_demand_efficiency = (
        (parseInt(arcStats.demand_data_hits) / totalDemandData) *
        100
      ).toFixed(2);
    }
  }

  if (arcStats.prefetch_data_hits && arcStats.prefetch_data_misses) {
    const totalPrefetchData =
      parseInt(arcStats.prefetch_data_hits) + parseInt(arcStats.prefetch_data_misses);
    if (totalPrefetchData > 0) {
      arcStats.data_prefetch_efficiency = (
        (parseInt(arcStats.prefetch_data_hits) / totalPrefetchData) *
        100
      ).toFixed(2);
    }
  }
};

/**
 * Parse kstat arcstats output
 * @param {string} output - Command output
 * @param {string} hostname - Host name
 * @returns {Object} Parsed ARC stats
 */
export const parseARCStatsOutput = (output, hostname) => {
  const lines = output.trim().split('\n');
  const arcStats = {
    host: hostname,
    scan_timestamp: new Date(),
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    // Parse format: zfs:0:arcstats:property_name    value
    const match = trimmed.match(/^zfs:0:arcstats:(?<property>\S+)\s+(?<value>\d+)$/);
    if (match) {
      const { property, value } = match.groups;
      // Map kstat properties to our model fields
      mapARCProperty(property, value, arcStats);
    }
  }

  // Calculate efficiency metrics
  calculateARCEfficiency(arcStats);

  return arcStats;
};
