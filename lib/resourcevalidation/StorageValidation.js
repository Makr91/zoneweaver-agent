/**
 * @fileoverview Storage Resource Validation
 * @description ZFS pool space validation for zone creation and modification.
 *              Two strategies: "committed" (full configured allocations) vs "actual" (current free space).
 */

import { executeCommand } from '../CommandManager.js';
import { parseUnitToBytes } from '../../controllers/StorageController/utils/ParsingUtils.js';
import config from '../../config/ConfigLoader.js';
import { log } from '../Logger.js';
import { formatBytes } from './ValidationHelpers.js';

// ─── Storage Internals ───────────────────────────────────────────────────────

/**
 * Query ZFS pool space info
 * @param {string} poolName - ZFS pool name (e.g., "rpool", "Array-1")
 * @returns {Promise<{total: number, alloc: number, free: number}|null>} Bytes, or null on failure
 */
const getPoolSpaceInfo = async poolName => {
  const result = await executeCommand(`zpool list -Hp -o size,alloc,free ${poolName}`);
  if (!result.success) {
    log.api.warn('Failed to query pool space', { pool: poolName, error: result.error });
    return null;
  }

  const parts = result.output.trim().split(/\s+/);
  if (parts.length < 3) {
    log.api.warn('Unexpected zpool list output', { pool: poolName, output: result.output });
    return null;
  }

  return {
    total: parseInt(parts[0], 10),
    alloc: parseInt(parts[1], 10),
    free: parseInt(parts[2], 10),
  };
};

/**
 * Sum all zvol volsizes on a pool (committed storage)
 * @param {string} poolName - ZFS pool name
 * @returns {Promise<number>} Total committed volsize in bytes
 */
const getPoolCommittedVolsize = async poolName => {
  const result = await executeCommand(`zfs list -Hpo volsize -t volume -r ${poolName}`);
  if (!result.success) {
    // Pool may have no volumes — that's fine
    return 0;
  }

  const lines = result.output.trim().split('\n').filter(Boolean);
  let total = 0;
  for (const line of lines) {
    const val = parseInt(line.trim(), 10);
    if (!isNaN(val)) {
      total += val;
    }
  }
  return total;
};

/**
 * Parse disk request body into per-pool byte totals
 * @param {Object} disks - Request body disks object
 * @returns {Map<string, number>} Pool name → total requested bytes
 */
export const calculateStorageRequest = disks => {
  const perPool = new Map();

  const addToPool = (pool, bytes) => {
    perPool.set(pool, (perPool.get(pool) || 0) + bytes);
  };

  if (!disks) {
    return perPool;
  }

  // Boot disk
  const { boot } = disks;
  if (boot) {
    // Skip existing dataset attachments (no pool/volume_name, just dataset path)
    const isExisting = boot.dataset && !boot.pool && !boot.volume_name;
    if (!isExisting) {
      const hasSource = boot.source?.type === 'template' || boot.source?.type === 'scratch';
      const hasNewVolume = boot.pool || boot.volume_name || boot.size;
      if (hasSource || hasNewVolume) {
        const pool = boot.pool || 'rpool';
        const sizeStr = boot.size || '48G';
        const bytes = parseInt(parseUnitToBytes(sizeStr) || '0', 10);
        if (bytes > 0) {
          addToPool(pool, bytes);
        }
      }
    }
  }

  // Additional disks
  const { additional } = disks;
  if (Array.isArray(additional)) {
    for (const disk of additional) {
      if (disk.create_new) {
        const pool = disk.pool || 'rpool';
        const sizeStr = disk.size || '50G';
        const bytes = parseInt(parseUnitToBytes(sizeStr) || '0', 10);
        if (bytes > 0) {
          addToPool(pool, bytes);
        }
      }
      // existing_dataset disks don't consume new space — skip
    }
  }

  return perPool;
};

/**
 * Validate storage space for requested disks
 * @param {Map<string, number>} requestedPerPool - Pool name → requested bytes
 * @returns {Promise<{valid: boolean, errors: Array, warnings: Array}>}
 */
export const validateStorage = async requestedPerPool => {
  const validationConfig = config.getResourceValidation();
  const storageConfig = validationConfig.storage || {};
  const strategy = storageConfig.strategy || 'committed';
  const thresholds = storageConfig.thresholds || {};
  const warningThreshold = thresholds.warning ?? 70;
  const criticalThreshold = thresholds.critical ?? 80;

  const errors = [];
  const warnings = [];

  const poolEntries = [...requestedPerPool.entries()];
  const results = await Promise.all(
    poolEntries.map(async ([poolName, requestedBytes]) => {
      const poolInfo = await getPoolSpaceInfo(poolName);
      if (!poolInfo) {
        return {
          error: {
            resource: 'storage',
            pool: poolName,
            strategy,
            message: `Unable to query pool "${poolName}" — pool may not exist`,
            requested_bytes: requestedBytes,
          },
        };
      }

      let projectedPct;
      let exceeded = false;

      if (strategy === 'committed') {
        const committed = await getPoolCommittedVolsize(poolName);
        const projected = committed + requestedBytes;
        projectedPct = (projected / poolInfo.total) * 100;

        if (projected > poolInfo.total) {
          exceeded = true;
          return {
            error: {
              resource: 'storage',
              pool: poolName,
              strategy,
              message: `Requested ${formatBytes(requestedBytes)} would exceed pool capacity (${formatBytes(committed)} committed + ${formatBytes(requestedBytes)} requested > ${formatBytes(poolInfo.total)} total)`,
              pool_total_bytes: poolInfo.total,
              committed_bytes: committed,
              requested_bytes: requestedBytes,
              projected_percent: Math.round(projectedPct * 100) / 100,
            },
          };
        }
      } else {
        // "actual" strategy
        projectedPct = ((poolInfo.alloc + requestedBytes) / poolInfo.total) * 100;

        if (requestedBytes > poolInfo.free) {
          exceeded = true;
          return {
            error: {
              resource: 'storage',
              pool: poolName,
              strategy,
              message: `Requested ${formatBytes(requestedBytes)} exceeds available pool space (${formatBytes(poolInfo.free)} free)`,
              pool_total_bytes: poolInfo.total,
              pool_free_bytes: poolInfo.free,
              requested_bytes: requestedBytes,
              projected_percent: Math.round(projectedPct * 100) / 100,
            },
          };
        }
      }

      // Threshold warnings (only if not already rejected)
      if (!exceeded) {
        const currentPct = (poolInfo.alloc / poolInfo.total) * 100;
        const roundedProjected = Math.round(projectedPct * 100) / 100;
        const roundedCurrent = Math.round(currentPct * 100) / 100;

        if (projectedPct > criticalThreshold) {
          return {
            warning: {
              resource: 'storage',
              level: 'critical',
              pool: poolName,
              message: `Pool will be ${roundedProjected}% utilized after this operation (critical threshold: ${criticalThreshold}%)`,
              current_percent: roundedCurrent,
              projected_percent: roundedProjected,
            },
          };
        }

        if (projectedPct > warningThreshold) {
          return {
            warning: {
              resource: 'storage',
              level: 'warning',
              pool: poolName,
              message: `Pool will be ${roundedProjected}% utilized after this operation (warning threshold: ${warningThreshold}%)`,
              current_percent: roundedCurrent,
              projected_percent: roundedProjected,
            },
          };
        }
      }

      return null;
    })
  );

  for (const result of results) {
    if (result?.error) {
      errors.push(result.error);
    }
    if (result?.warning) {
      warnings.push(result.warning);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
};
