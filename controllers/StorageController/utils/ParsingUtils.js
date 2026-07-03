/**
 * @fileoverview Storage Data Parsing Utilities
 * @description Shared parsing functions for ZFS and storage-related command outputs
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

/**
 * Parse zpool iostat output
 * @param {string} output - Command output
 * @param {string} hostname - Host name
 * @returns {Array} Parsed pool data
 */
export const parsePoolIostatOutput = (output, hostname) => {
  const lines = output.trim().split('\n');
  const pools = [];

  let inDataSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip header lines until we find the pool data
    if (line.includes('pool') && line.includes('alloc') && line.includes('free')) {
      inDataSection = true;
      continue;
    }

    if (line.includes('-----')) {
      continue;
    }

    if (inDataSection && line) {
      // Skip repeated header blocks only — a substring test on "pool" would also
      // drop every pool whose name contains it (rpool!)
      if (line.includes('alloc') && line.includes('free')) {
        continue;
      }
      const parts = line.split(/\s+/);
      if (parts.length >= 7) {
        const allocBytes = parseUnitToBytes(parts[1]);
        const freeBytes = parseUnitToBytes(parts[2]);

        pools.push({
          host: hostname,
          pool: parts[0],
          alloc: parts[1],
          free: parts[2],
          alloc_bytes: allocBytes,
          free_bytes: freeBytes,
          capacity: calculateCapacity(allocBytes, freeBytes),
          read_ops: parts[3],
          write_ops: parts[4],
          read_bandwidth: parts[5],
          write_bandwidth: parts[6],
          scan_type: 'iostat',
          scan_timestamp: new Date(),
        });
      }
    }
  }

  return pools;
};

/**
 * Parse zpool status output
 * @param {string} output - Command output
 * @param {string} hostname - Host name
 * @returns {Array} Parsed pool status data
 */
export const parsePoolStatusOutput = (output, hostname) => {
  const pools = [];
  const sections = output.split(/pool:/);

  for (let i = 1; i < sections.length; i++) {
    const section = sections[i].trim();
    const lines = section.split('\n');

    if (lines.length === 0) {
      continue;
    }

    const poolName = lines[0].trim();
    let state = null;
    let status = null;
    let errors = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('state:')) {
        state = trimmed.replace('state:', '').trim();
      } else if (trimmed.startsWith('status:')) {
        status = trimmed.replace('status:', '').trim();
      } else if (trimmed.startsWith('errors:')) {
        errors = trimmed.replace('errors:', '').trim();
      }
    }

    pools.push({
      host: hostname,
      pool: poolName,
      health: state,
      status,
      errors,
      scan_type: 'status',
      scan_timestamp: new Date(),
    });
  }

  return pools;
};

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

/**
 * Parse zpool list output
 * @param {string} output - Command output
 * @param {string} hostname - Host name
 * @returns {Array} Parsed pool data
 */
export const parsePoolListOutput = (output, hostname) => {
  const lines = output.trim().split('\n');
  const pools = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length >= 10) {
      const allocBytes = parseUnitToBytes(parts[2]);
      const freeBytes = parseUnitToBytes(parts[3]);

      pools.push({
        host: hostname,
        pool: parts[0],
        alloc: parts[2],
        free: parts[3],
        alloc_bytes: allocBytes,
        free_bytes: freeBytes,
        capacity: calculateCapacity(allocBytes, freeBytes),
        // zpool list -H columns: name size alloc free ckpoint expandsz frag cap
        // dedup health altroot — health is second-to-last (parts[6] is FRAG)
        health: parts[parts.length - 2],
        scan_type: 'list',
        scan_timestamp: new Date(),
      });
    }
  }

  return pools;
};

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

/**
 * Create pool statistics object from parsed parts
 * @param {Array} parts - Parsed line parts
 * @param {string} hostname - Host name
 * @param {string} currentPool - Current pool name
 * @returns {Object} Pool statistics object
 */
const createPoolStat = (parts, hostname, currentPool) => {
  const [
    ,
    alloc,
    free,
    readOps,
    writeOps,
    readBandwidth,
    writeBandwidth,
    totalWaitRead,
    totalWaitWrite,
    diskWaitRead,
    diskWaitWrite,
    syncqWaitRead,
    syncqWaitWrite,
    asyncqWaitRead,
    asyncqWaitWrite,
    scrubWait,
    trimWait,
  ] = parts;

  return {
    host: hostname,
    pool: currentPool,
    pool_type: null, // Will be set by topology line
    alloc,
    free,
    read_ops: readOps,
    write_ops: writeOps,
    read_bandwidth: readBandwidth,
    write_bandwidth: writeBandwidth,
    read_bandwidth_bytes: parseUnitToBytes(readBandwidth),
    write_bandwidth_bytes: parseUnitToBytes(writeBandwidth),
    total_wait_read: totalWaitRead,
    total_wait_write: totalWaitWrite,
    disk_wait_read: diskWaitRead,
    disk_wait_write: diskWaitWrite,
    syncq_wait_read: syncqWaitRead,
    syncq_wait_write: syncqWaitWrite,
    asyncq_wait_read: asyncqWaitRead,
    asyncq_wait_write: asyncqWaitWrite,
    scrub_wait: scrubWait,
    trim_wait: trimWait,
    scan_timestamp: new Date(),
  };
};

/**
 * Create disk statistics object from parsed parts
 * @param {Array} parts - Parsed line parts
 * @param {string} hostname - Host name
 * @param {string} currentPool - Current pool name
 * @returns {Object} Disk statistics object
 */
const createDiskStat = (parts, hostname, currentPool) => {
  const [deviceName, allocRaw, freeRaw, readOps, writeOps, readBandwidth, writeBandwidth] = parts;

  return {
    host: hostname,
    pool: currentPool,
    device_name: deviceName,
    alloc: allocRaw === '-' ? '0' : allocRaw,
    free: freeRaw === '-' ? '0' : freeRaw,
    read_ops: readOps,
    write_ops: writeOps,
    read_bandwidth: readBandwidth,
    write_bandwidth: writeBandwidth,
    read_bandwidth_bytes: parseUnitToBytes(readBandwidth),
    write_bandwidth_bytes: parseUnitToBytes(writeBandwidth),
    scan_timestamp: new Date(),
  };
};

/**
 * Process topology line (raidz, mirror, etc.)
 * @param {Array} parts - Parsed line parts
 * @param {boolean} isInSecondDataSet - Whether in second dataset
 * @param {string} currentPool - Current pool name
 * @param {Map} poolDataSets - Pool data sets tracking
 * @param {Array} poolStats - Pool statistics array
 */
const processTopologyLine = (parts, isInSecondDataSet, currentPool, poolDataSets, poolStats) => {
  if (isInSecondDataSet && currentPool) {
    const poolType = parts[0].replace(/-\d+$/, '');

    // Increment vdev count for this pool
    if (poolDataSets.has(currentPool)) {
      poolDataSets.get(currentPool).vdevCount++;
    }

    // Find the pool record we just created and update its pool_type (only if not already set)
    const poolToUpdate = currentPool; // Capture the value to avoid loop function closure issue
    const lastPool = poolStats.find(p => p.pool === poolToUpdate);
    if (lastPool && !lastPool.pool_type) {
      lastPool.pool_type = poolType;
    }
  }
};

/**
 * Parse zpool iostat -l -H -v output for comprehensive I/O statistics
 * @param {string} output - Command output from pfexec zpool iostat -l -H -v 1 2
 * @param {string} hostname - Host name
 * @param {Set} discoveredPools - Set of discovered pool names
 * @returns {Object} Object containing both poolStats and diskStats arrays
 */
export const parseComprehensiveIOStats = (output, hostname, discoveredPools) => {
  const lines = output.trim().split('\n');
  const poolStats = [];
  const diskStats = [];
  let currentPool = null;
  let isInSecondDataSet = false;

  // Track per-pool state instead of global state
  const poolDataSets = new Map(); // poolName -> { foundFirst: boolean, vdevCount: 0, diskCount: 0 }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parts = trimmed.split(/\s+/);

    // Skip lines that don't have the expected number of columns
    if (parts.length !== 17) {
      continue;
    }

    // FIRST: Check if this is a topology line (raidz1, raidz2, mirror) - these should NOT be treated as pools
    if (parts[0].match(/^(?<type>raidz1|raidz2|raidz3|mirror|cache|log|spare)(?<suffix>-\d+)?$/)) {
      processTopologyLine(parts, isInSecondDataSet, currentPool, poolDataSets, poolStats);
      continue; // Skip further processing for topology lines
    }

    // SECOND: Check if this is a pool line
    if (discoveredPools.has(parts[0])) {
      const [poolName] = parts;

      // Initialize pool tracking if not exists
      if (!poolDataSets.has(poolName)) {
        poolDataSets.set(poolName, { foundFirst: false, vdevCount: 0, diskCount: 0 });
      }

      const poolData = poolDataSets.get(poolName);

      if (!poolData.foundFirst) {
        // This is the first data set (cumulative) for this pool, skip it
        poolData.foundFirst = true;
        continue;
      }

      // This is the second data set (real-time) for this pool, process it
      isInSecondDataSet = true;
      currentPool = poolName;

      const poolStat = createPoolStat(parts, hostname, currentPool);
      poolStats.push(poolStat);
      continue;
    }

    // THIRD: Check if this is a disk line (only if we're in the second dataset)
    if (isInSecondDataSet && currentPool && parts[0].startsWith('c') && parts[0].includes('t')) {
      // Increment disk count for this pool
      if (poolDataSets.has(currentPool)) {
        poolDataSets.get(currentPool).diskCount++;
      }

      const diskStat = createDiskStat(parts, hostname, currentPool);
      diskStats.push(diskStat);
    }
  }

  return { poolStats, diskStats };
};
