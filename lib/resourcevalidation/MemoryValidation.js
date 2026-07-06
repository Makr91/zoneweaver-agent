/**
 * @fileoverview Memory Resource Validation
 * @description Host memory validation with ZFS ARC accounting for zone creation and modification.
 *              Two strategies: "committed" (full configured allocations) vs "actual" (current free space).
 */

import os from 'os';
import { executeCommand } from '../CommandManager.js';
import { parseUnitToBytes } from '../../controllers/StorageController/utils/ParsingUtils.js';
import config from '../../config/ConfigLoader.js';
import Zones from '../../models/ZoneModel.js';
import { formatBytes, parseZoneConfig } from './ValidationHelpers.js';

// ─── Memory Internals ───────────────────────────────────────────────────────

/**
 * Query ZFS ARC statistics via kstat
 * @returns {Promise<{arcMinSize: number, arcCurrentSize: number}>} ARC sizes in bytes
 */
const getArcStats = async () => {
  const result = await executeCommand('kstat -p zfs:0:arcstats');
  if (!result.success) {
    return { arcMinSize: 0, arcCurrentSize: 0 };
  }

  let arcMinSize = 0;
  let arcCurrentSize = 0;
  const lines = result.output.trim().split('\n');
  for (const line of lines) {
    const match = line.match(/^zfs:0:arcstats:(?<prop>\S+)\s+(?<val>\d+)$/);
    if (match) {
      if (match.groups.prop === 'c_min') {
        arcMinSize = parseInt(match.groups.val, 10);
      } else if (match.groups.prop === 'size') {
        arcCurrentSize = parseInt(match.groups.val, 10);
      }
    }
  }
  return { arcMinSize, arcCurrentSize };
};

/**
 * Sum committed RAM across all zones from DB configuration
 * @param {string|null} excludeZoneName - Zone to exclude (for modifications)
 * @param {boolean} runningOnly - Only count running zones (for "actual" strategy)
 * @returns {Promise<number>} Total committed RAM in bytes
 */
const getZoneCommittedMemory = async (excludeZoneName, runningOnly) => {
  const where = {};
  if (runningOnly) {
    where.status = 'running';
  }
  const zones = await Zones.findAll({
    attributes: ['name', 'configuration'],
    where,
  });

  let total = 0;
  for (const zone of zones) {
    if (excludeZoneName && zone.name === excludeZoneName) {
      continue;
    }
    const cfg = parseZoneConfig(zone);
    if (!cfg?.ram) {
      continue;
    }
    const bytes = parseInt(parseUnitToBytes(cfg.ram) || '0', 10);
    if (bytes > 0) {
      total += bytes;
    }
  }
  return total;
};

/**
 * Extract requested RAM from zone creation body
 * @param {Object} requestBody - Zone creation request body
 * @returns {number} Requested RAM in bytes, or 0
 */
export const calculateMemoryRequest = requestBody => {
  const ram = requestBody.settings?.memory;
  if (!ram) {
    return 0;
  }
  return parseInt(parseUnitToBytes(ram) || '0', 10);
};

/**
 * Extract requested RAM from zone modification body
 * @param {Object} requestBody - Zone modification request body
 * @returns {number} Requested RAM in bytes, or 0
 */
export const calculateModificationMemoryRequest = requestBody => {
  if (!requestBody.ram) {
    return 0;
  }
  return parseInt(parseUnitToBytes(requestBody.ram) || '0', 10);
};

/**
 * Validate memory availability for a zone operation
 * @param {number} requestedBytes - Requested RAM in bytes
 * @param {string|null} excludeZoneName - Zone to exclude from committed sum (for modifications)
 * @returns {Promise<{valid: boolean, errors: Array, warnings: Array}>}
 */
export const validateMemory = async (requestedBytes, excludeZoneName) => {
  const validationConfig = config.getResourceValidation();
  const memoryConfig = validationConfig.memory || {};
  const strategy = memoryConfig.strategy || 'committed';
  const arcAccounting = memoryConfig.arc_accounting !== false;
  const thresholds = memoryConfig.thresholds || {};
  const warningThreshold = thresholds.warning ?? 80;
  const criticalThreshold = thresholds.critical ?? 90;

  const errors = [];
  const warnings = [];

  const hostTotal = os.totalmem();

  // Get ARC stats for accounting
  let arcMinSize = 0;
  let arcCurrentSize = 0;
  if (arcAccounting) {
    ({ arcMinSize, arcCurrentSize } = await getArcStats());
  }

  let projectedPct;

  if (strategy === 'committed') {
    const effectiveTotal = hostTotal - arcMinSize;
    const committed = await getZoneCommittedMemory(excludeZoneName, false);
    const projected = committed + requestedBytes;
    projectedPct = (projected / effectiveTotal) * 100;

    if (projected > effectiveTotal) {
      errors.push({
        resource: 'memory',
        strategy,
        message: `Requested ${formatBytes(requestedBytes)} would exceed effective host memory (${formatBytes(committed)} committed + ${formatBytes(requestedBytes)} requested > ${formatBytes(effectiveTotal)} effective${arcMinSize > 0 ? `, after ${formatBytes(arcMinSize)} ARC minimum reserved` : ''})`,
        host_total_bytes: hostTotal,
        effective_total_bytes: effectiveTotal,
        committed_bytes: committed,
        requested_bytes: requestedBytes,
        arc_min_bytes: arcMinSize,
        projected_percent: Math.round(projectedPct * 100) / 100,
      });
      return { valid: false, errors, warnings };
    }
  } else {
    // "actual" strategy — use real-time system memory with ARC accounting
    const hostFree = os.freemem();
    const reclaimableArc = Math.max(0, arcCurrentSize - arcMinSize);
    const effectiveFree = hostFree + reclaimableArc;
    projectedPct = ((hostTotal - effectiveFree + requestedBytes) / hostTotal) * 100;

    if (requestedBytes > effectiveFree) {
      errors.push({
        resource: 'memory',
        strategy,
        message: `Requested ${formatBytes(requestedBytes)} exceeds available host memory (${formatBytes(effectiveFree)} effective free${reclaimableArc > 0 ? `, including ${formatBytes(reclaimableArc)} reclaimable ARC` : ''})`,
        host_total_bytes: hostTotal,
        effective_free_bytes: effectiveFree,
        host_free_bytes: hostFree,
        reclaimable_arc_bytes: reclaimableArc,
        requested_bytes: requestedBytes,
        projected_percent: Math.round(projectedPct * 100) / 100,
      });
      return { valid: false, errors, warnings };
    }
  }

  // Threshold warnings
  const roundedProjected = Math.round(projectedPct * 100) / 100;

  if (projectedPct > criticalThreshold) {
    warnings.push({
      resource: 'memory',
      level: 'critical',
      message: `Host memory will be ${roundedProjected}% utilized after this operation (critical threshold: ${criticalThreshold}%)`,
      projected_percent: roundedProjected,
    });
  } else if (projectedPct > warningThreshold) {
    warnings.push({
      resource: 'memory',
      level: 'warning',
      message: `Host memory will be ${roundedProjected}% utilized after this operation (warning threshold: ${warningThreshold}%)`,
      projected_percent: roundedProjected,
    });
  }

  return { valid: true, errors, warnings };
};
