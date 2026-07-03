/**
 * @fileoverview Host Management Utilities
 * @description Shared utilities for host information management and error handling
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import os from 'os';
import HostInfo from '../../../models/HostInfoModel.js';
import { log } from '../../../lib/Logger.js';

/**
 * Update host information record
 * @param {string} hostname - Host name
 * @param {Object} updates - Fields to update
 */
export const updateHostInfo = async (hostname, updates) => {
  try {
    await HostInfo.upsert({
      host: hostname,
      hostname,
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptime: Math.floor(os.uptime()),
      ...updates,
      updated_at: new Date(),
    });
  } catch (error) {
    log.database.error('Failed to update host info', {
      error: error.message,
      hostname,
      updates: Object.keys(updates),
    });
  }
};

/**
 * Error handler class for storage collection operations
 */
export class StorageErrorHandler {
  constructor(hostname, hostMonitoringConfig) {
    this.hostname = hostname;
    this.hostMonitoringConfig = hostMonitoringConfig;
    this.errorCount = 0;
    this.lastErrorReset = Date.now();
  }

  /**
   * Handle collection errors with exponential backoff and threshold management
   * @param {Error} error - The error that occurred
   * @param {string} operation - The operation that failed
   * @returns {Promise<boolean>} Whether to continue collecting (true) or disable (false)
   */
  async handleError(error, operation) {
    this.errorCount++;

    const now = Date.now();
    const timeSinceLastReset = now - this.lastErrorReset;
    const resetInterval = this.hostMonitoringConfig.error_handling.reset_error_count_after * 1000;

    // Reset error count if enough time has passed
    if (timeSinceLastReset > resetInterval) {
      this.errorCount = 1;
      this.lastErrorReset = now;
    }

    const maxErrors = this.hostMonitoringConfig.error_handling.max_consecutive_errors;
    const errorMessage = `${operation} failed: ${error.message}`;

    log.monitoring.error('Storage collection error', {
      error: error.message,
      operation,
      error_count: this.errorCount,
      max_errors: maxErrors,
      hostname: this.hostname,
    });

    await updateHostInfo(this.hostname, {
      storage_scan_errors: this.errorCount,
      last_error_message: errorMessage,
    });

    if (this.errorCount >= maxErrors) {
      log.monitoring.error('Storage collector disabled due to consecutive errors', {
        error_count: this.errorCount,
        max_errors: maxErrors,
        operation,
        hostname: this.hostname,
      });
      return false; // Signal to disable collector
    }

    return true; // Continue collecting
  }

  /**
   * Reset error count on successful operation
   */
  async resetErrorCount() {
    if (this.errorCount > 0) {
      this.errorCount = 0;
      await updateHostInfo(this.hostname, {
        storage_scan_errors: 0,
        last_error_message: null,
      });
    }
  }

  /**
   * Get current error count
   * @returns {number} Current error count
   */
  getErrorCount() {
    return this.errorCount;
  }
}

/**
 * Discovery cache manager for pools and zones
 */
export class DiscoveryCache {
  constructor() {
    this.discoveredPools = new Set();
    this.discoveredZones = new Set();
  }

  /**
   * Add pool to discovery cache
   * @param {string} poolName - Pool name to add
   */
  addPool(poolName) {
    this.discoveredPools.add(poolName);
  }

  /**
   * Add zone to discovery cache
   * @param {string} zoneName - Zone name to add
   */
  addZone(zoneName) {
    this.discoveredZones.add(zoneName);
  }

  /**
   * Get discovered pools
   * @returns {Set} Set of discovered pool names
   */
  getPools() {
    return this.discoveredPools;
  }

  /**
   * Get discovered zones
   * @returns {Set} Set of discovered zone names
   */
  getZones() {
    return this.discoveredZones;
  }

  /**
   * Clear all cached discoveries
   */
  clear() {
    this.discoveredPools.clear();
    this.discoveredZones.clear();
  }

  /**
   * Check if a pool is discovered
   * @param {string} poolName - Pool name to check
   * @returns {boolean} Whether pool is discovered
   */
  hasPool(poolName) {
    return this.discoveredPools.has(poolName);
  }

  /**
   * Check if a zone is discovered
   * @param {string} zoneName - Zone name to check
   * @returns {boolean} Whether zone is discovered
   */
  hasZone(zoneName) {
    return this.discoveredZones.has(zoneName);
  }
}

/**
 * Batch processor for database operations
 */
export class BatchProcessor {
  constructor(batchSize) {
    this.batchSize = batchSize;
  }

  /**
   * Process data in batches using the provided operation function
   * @param {Array} data - Data to process in batches
   * @param {Function} operationFn - Function to execute for each batch
   * @returns {Promise<Array>} Results from all batch operations
   */
  async processBatches(data, operationFn) {
    // Create batches array
    const batches = [];
    for (let i = 0; i < data.length; i += this.batchSize) {
      batches.push(data.slice(i, i + this.batchSize));
    }

    // Process all batches in parallel using map and Promise.allSettled
    const batchPromises = batches.map(async (batch, index) => {
      try {
        const result = await operationFn(batch);
        return { success: true, result, batchIndex: index };
      } catch (error) {
        log.database.error('Batch processing failed', {
          error: error.message,
          batch_index: index,
          batch_size: batch.length,
        });
        return { success: false, error: error.message, batchIndex: index };
      }
    });

    const batchResults = await Promise.allSettled(batchPromises);

    // Extract successful results
    const results = [];
    batchResults.forEach(settledResult => {
      if (settledResult.status === 'fulfilled' && settledResult.value.success) {
        results.push(settledResult.value.result);
      }
    });

    return results;
  }
}

/**
 * Filter datasets to only include zone/VM-related datasets using dynamic zone discovery
 * @param {Array} datasets - Array of all datasets
 * @param {Set} discoveredZones - Set of discovered zone names
 * @returns {Array} Filtered datasets for zones/VMs only
 */
export const filterZoneDatasets = (datasets, discoveredZones) =>
  datasets.filter(dataset => {
    const name = dataset.name.toLowerCase();

    // Include datasets that contain "zones" in the path (generic pattern)
    if (name.includes('/zones/')) {
      return true;
    }

    // Include datasets that match common VM/zone patterns (generic)
    if (name.includes('/vm/') || name.includes('/vms/')) {
      return true;
    }

    // Include datasets that match discovered zone names
    for (const zoneName of discoveredZones) {
      const zoneNameLower = zoneName.toLowerCase();
      if (name.includes(`/${zoneNameLower}/`) || name.includes(`/${zoneNameLower}`)) {
        return true;
      }
    }

    // Include bhyve/kvm patterns (generic hypervisor patterns)
    if (name.includes('/bhyve/') || name.includes('/kvm/')) {
      return true;
    }

    // Exclude root pools and system datasets
    if (name.split('/').length <= 1) {
      return false;
    }

    return false;
  });

/**
 * Assign disks to pools based on zpool status output
 * @param {Array} diskData - Array of disk objects
 * @param {string} zpoolStatusOutput - Output from zpool status command
 */
export const assignDisksToePools = (diskData, zpoolStatusOutput) => {
  const poolSections = zpoolStatusOutput.split(/pool:/);

  for (let i = 1; i < poolSections.length; i++) {
    const section = poolSections[i].trim();
    const lines = section.split('\n');

    if (lines.length === 0) {
      continue;
    }

    const poolName = lines[0].trim();

    // Look for disk device names in the pool status
    for (const line of lines) {
      const trimmed = line.trim();

      // Look for device names that match our disk inventory
      for (const disk of diskData) {
        // Check if the device name or serial number appears in the zpool status
        if (
          trimmed.includes(disk.device_name) ||
          (disk.serial_number && trimmed.includes(disk.serial_number.toLowerCase()))
        ) {
          disk.pool_assignment = poolName;
          disk.is_available = false; // Disk is in use
        }
      }
    }
  }
};
