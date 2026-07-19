/**
 * @fileoverview Zone Resource Validation Orchestrators
 * @description Pre-flight resource validation entry points for zone creation and modification.
 *              Runs all enabled resource validators (storage, memory, CPU) in parallel.
 */

import config from '../../config/ConfigLoader.js';
import { log } from '../Logger.js';
import { calculateStorageRequest, validateStorage } from './StorageValidation.js';
import {
  calculateMemoryRequest,
  calculateModificationMemoryRequest,
  validateMemory,
} from './MemoryValidation.js';
import {
  calculateCpuRequest,
  calculateModificationCpuRequest,
  validateCpu,
} from './CpuValidation.js';

// ─── Exported Validation Functions ───────────────────────────────────────────

/**
 * Validate resources for zone creation
 * Checks all enabled resource types (storage, memory, CPU) in parallel
 * @param {Object} requestBody - Full zone creation request body
 * @returns {Promise<{valid: boolean, errors: Array, warnings: Array}>}
 */
export const validateZoneCreationResources = async requestBody => {
  const validationConfig = config.getResourceValidation();
  if (!validationConfig.enabled) {
    return { valid: true, errors: [], warnings: [] };
  }

  const validators = [];

  // Storage validation
  if (validationConfig.storage) {
    const requestedPerPool = await calculateStorageRequest(requestBody.disks);
    if (requestedPerPool.size > 0) {
      validators.push(validateStorage(requestedPerPool));
    }
  }

  // Memory validation
  if (validationConfig.memory) {
    const requestedRam = calculateMemoryRequest(requestBody);
    if (requestedRam > 0) {
      validators.push(validateMemory(requestedRam, null));
    }
  }

  // CPU validation
  if (validationConfig.cpu) {
    const requestedCpus = calculateCpuRequest(requestBody);
    if (requestedCpus > 0) {
      validators.push(validateCpu(requestedCpus, null));
    }
  }

  const results = await Promise.all(validators);
  const allErrors = [];
  const allWarnings = [];
  for (const result of results) {
    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
  }

  return { valid: allErrors.length === 0, errors: allErrors, warnings: allWarnings };
};

/**
 * Validate resources for zone modification
 * Only checks resources being changed (add_disks → storage, ram → memory, vcpus → CPU)
 * @param {Object} requestBody - Zone modification request body
 * @param {string} zoneName - Zone being modified (excluded from committed sums)
 * @returns {Promise<{valid: boolean, errors: Array, warnings: Array}>}
 */
export const validateZoneModificationResources = async (requestBody, zoneName) => {
  const validationConfig = config.getResourceValidation();
  if (!validationConfig.enabled) {
    return { valid: true, errors: [], warnings: [] };
  }

  const validators = [];

  // Storage validation for add_disks — the TYPED entries (the create wire's
  // reader, reused verbatim: blank + size consume space, image never).
  if (validationConfig.storage && requestBody.add_disks) {
    const requestedPerPool = await calculateStorageRequest({
      additional_disks: requestBody.add_disks,
    });
    if (requestedPerPool.size > 0) {
      validators.push(validateStorage(requestedPerPool));
    }
  }

  // Memory validation for ram changes
  if (validationConfig.memory && requestBody.ram) {
    const requestedRam = calculateModificationMemoryRequest(requestBody);
    if (requestedRam > 0) {
      validators.push(validateMemory(requestedRam, zoneName));
    }
  }

  // CPU validation for vcpus changes
  if (validationConfig.cpu && (requestBody.vcpus || requestBody.cpu_configuration)) {
    const requestedCpus = calculateModificationCpuRequest(requestBody);
    if (requestedCpus > 0) {
      validators.push(validateCpu(requestedCpus, zoneName));
    }
  }

  const results = await Promise.all(validators);
  const allErrors = [];
  const allWarnings = [];
  for (const result of results) {
    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
  }

  if (allErrors.length > 0 || allWarnings.length > 0) {
    log.api.info('Resource validation for zone modification', {
      zone_name: zoneName,
      errors: allErrors.length,
      warnings: allWarnings.length,
    });
  }

  return { valid: allErrors.length === 0, errors: allErrors, warnings: allWarnings };
};
