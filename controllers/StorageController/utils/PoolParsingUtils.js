/**
 * @fileoverview ZFS pool parsing utilities
 * @description Parsers for zpool iostat/status/list output, including the
 * comprehensive per-pool/per-disk I/O statistics parser.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { parseUnitToBytes, calculateCapacity } from './UnitParsingUtils.js';

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
