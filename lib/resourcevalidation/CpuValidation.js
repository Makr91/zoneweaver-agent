/**
 * @fileoverview CPU Resource Validation
 * @description Host vCPU overcommit validation for zone creation and modification.
 *              Two strategies: "committed" (all configured zones) vs "actual" (running zones only).
 */

import os from 'os';
import config from '../../config/ConfigLoader.js';
import Zones from '../../models/ZoneModel.js';
import { parseZoneConfig } from './ValidationHelpers.js';

// ─── CPU Internals ──────────────────────────────────────────────────────────

/**
 * Parse vCPU count from zadm configuration value
 * Handles simple ("2") and complex topology ("sockets=2,cores=2,threads=1")
 * @param {string|number} vcpuValue - vCPU configuration value
 * @returns {number} Total vCPU count
 */
const parseVcpuCount = vcpuValue => {
  if (!vcpuValue) {
    return 0;
  }
  const str = String(vcpuValue);

  // Simple: just a number
  if (/^\d+$/.test(str)) {
    return parseInt(str, 10);
  }

  // Complex topology: "sockets=N,cores=N,threads=N"
  const socketMatch = str.match(/sockets=(?<n>\d+)/);
  const coreMatch = str.match(/cores=(?<n>\d+)/);
  const threadMatch = str.match(/threads=(?<n>\d+)/);
  if (socketMatch && coreMatch && threadMatch) {
    return (
      parseInt(socketMatch.groups.n, 10) *
      parseInt(coreMatch.groups.n, 10) *
      parseInt(threadMatch.groups.n, 10)
    );
  }

  return 0;
};

/**
 * Sum committed vCPUs across all zones from DB configuration
 * @param {string|null} excludeZoneName - Zone to exclude (for modifications)
 * @param {boolean} runningOnly - Only count running zones (for "actual" strategy)
 * @returns {Promise<number>} Total committed vCPUs
 */
const getZoneCommittedCpus = async (excludeZoneName, runningOnly) => {
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
    if (!cfg?.vcpus) {
      continue;
    }
    const count = parseVcpuCount(cfg.vcpus);
    if (count > 0) {
      total += count;
    }
  }
  return total;
};

/**
 * Extract requested vCPUs from zone creation body
 * @param {Object} requestBody - Zone creation request body
 * @returns {number} Requested vCPU count, or 0
 */
export const calculateCpuRequest = requestBody => {
  // Complex CPU topology takes priority
  if (
    requestBody.zones?.cpu_configuration === 'complex' &&
    requestBody.zones?.complex_cpu_conf?.[0]
  ) {
    const [conf] = requestBody.zones.complex_cpu_conf;
    return (conf.sockets || 1) * (conf.cores || 1) * (conf.threads || 1);
  }
  const vcpus = requestBody.settings?.vcpus;
  if (!vcpus) {
    return 0;
  }
  return parseInt(String(vcpus), 10) || 0;
};

/**
 * Extract requested vCPUs from zone modification body
 * @param {Object} requestBody - Zone modification request body
 * @returns {number} Requested vCPU count, or 0
 */
export const calculateModificationCpuRequest = requestBody => {
  if (requestBody.cpu_configuration === 'complex' && requestBody.complex_cpu_conf?.[0]) {
    const [conf] = requestBody.complex_cpu_conf;
    return (conf.sockets || 1) * (conf.cores || 1) * (conf.threads || 1);
  }
  const { vcpus } = requestBody;
  if (!vcpus) {
    return 0;
  }
  return parseInt(String(vcpus), 10) || 0;
};

/**
 * Validate CPU availability for a zone operation
 * @param {number} requestedVcpus - Requested vCPU count
 * @param {string|null} excludeZoneName - Zone to exclude from committed sum (for modifications)
 * @returns {Promise<{valid: boolean, errors: Array, warnings: Array}>}
 */
export const validateCpu = async (requestedVcpus, excludeZoneName) => {
  const validationConfig = config.getResourceValidation();
  const cpuConfig = validationConfig.cpu || {};
  const strategy = cpuConfig.strategy || 'committed';
  const hardLimit = cpuConfig.hard_limit ?? 400;
  const thresholds = cpuConfig.thresholds || {};
  const warningThreshold = thresholds.warning ?? 150;
  const criticalThreshold = thresholds.critical ?? 300;

  const errors = [];
  const warnings = [];

  const hostCpus = os.cpus().length;
  const runningOnly = strategy === 'actual';
  const committed = await getZoneCommittedCpus(excludeZoneName, runningOnly);
  const projected = committed + requestedVcpus;
  const projectedPct = (projected / hostCpus) * 100;

  if (projectedPct > hardLimit) {
    errors.push({
      resource: 'cpu',
      strategy,
      message: `Requested ${requestedVcpus} vCPUs would exceed overcommit limit (${committed} allocated + ${requestedVcpus} requested = ${projected} total vCPUs, ${Math.round(projectedPct)}% of ${hostCpus} physical cores, limit: ${hardLimit}%)`,
      host_cpu_count: hostCpus,
      committed_vcpus: committed,
      requested_vcpus: requestedVcpus,
      projected_vcpus: projected,
      projected_percent: Math.round(projectedPct * 100) / 100,
      hard_limit_percent: hardLimit,
    });
    return { valid: false, errors, warnings };
  }

  // Threshold warnings
  const roundedProjected = Math.round(projectedPct * 100) / 100;

  if (projectedPct > criticalThreshold) {
    warnings.push({
      resource: 'cpu',
      level: 'critical',
      message: `Host vCPU allocation will be ${roundedProjected}% after this operation (${hostCpus} physical cores, ${projected} allocated vCPUs) (critical threshold: ${criticalThreshold}%)`,
      projected_percent: roundedProjected,
    });
  } else if (projectedPct > warningThreshold) {
    warnings.push({
      resource: 'cpu',
      level: 'warning',
      message: `Host vCPU allocation will be ${roundedProjected}% after this operation (${hostCpus} physical cores, ${projected} allocated vCPUs) (warning threshold: ${warningThreshold}%)`,
      projected_percent: roundedProjected,
    });
  }

  return { valid: true, errors, warnings };
};
