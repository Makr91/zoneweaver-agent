/**
 * @fileoverview Storage Data Collection Controller for Zoneweaver Agent
 * @description Main orchestrator for ZFS pool and dataset information collection
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import os from 'os';
import { Op } from 'sequelize';
import config from '../../config/ConfigLoader.js';
import ZFSPools from '../../models/ZFSPoolModel.js';
import ZFSDatasets from '../../models/ZFSDatasetModel.js';
import Disks from '../../models/DiskModel.js';
import DiskIOStats from '../../models/DiskIOStatsModel.js';
import ARCStats from '../../models/ARCStatsModel.js';
import PoolIOStats from '../../models/PoolIOStatsModel.js';
import { log } from '../../lib/Logger.js';
import { executeZpoolList, executeZoneList, safeExecuteCommand } from './utils/CommandUtils.js';
import { StorageErrorHandler, DiscoveryCache, updateHostInfo } from './utils/HostUtils.js';
import PoolCollector from './PoolCollector.js';
import DatasetCollector from './DatasetCollector.js';
import DiskCollector from './DiskCollector.js';
import ARCCollector from './ARCCollector.js';
import IOStatsCollector from './IOStatsCollector.js';

/**
 * Storage Data Collector Class
 * @description Handles collection of ZFS pool and dataset information
 */
class StorageCollector {
  constructor() {
    this.hostMonitoringConfig = config.getHostMonitoring();
    this.hostname = os.hostname();
    this.isCollecting = false;

    // Initialize utility classes
    this.errorHandler = new StorageErrorHandler(this.hostname, this.hostMonitoringConfig);
    this.discoveryCache = new DiscoveryCache();

    // Initialize collector modules
    this.poolCollector = new PoolCollector(this.hostname, this.hostMonitoringConfig);
    this.datasetCollector = new DatasetCollector(this.hostname, this.hostMonitoringConfig);
    this.diskCollector = new DiskCollector(this.hostname, this.hostMonitoringConfig);
    this.arcCollector = new ARCCollector(this.hostname, this.hostMonitoringConfig);
    this.ioStatsCollector = new IOStatsCollector(this.hostname, this.hostMonitoringConfig);
  }

  /**
   * Update host information record
   * @param {Object} updates - Fields to update
   */
  async updateHostInfo(updates) {
    await updateHostInfo(this.hostname, updates);
  }

  /**
   * Handle collection errors
   * @param {Error} error - The error that occurred
   * @param {string} operation - The operation that failed
   * @returns {Promise<boolean>} Whether to continue collecting
   */
  handleError(error, operation) {
    return this.errorHandler.handleError(error, operation);
  }

  /**
   * Reset error count on successful operation
   */
  async resetErrorCount() {
    await this.errorHandler.resetErrorCount();
  }

  /**
   * Discover actual pool names from the system
   * @description Uses zpool list to get real pool names instead of hardcoded assumptions
   * @returns {Promise<Set>} Set of discovered pool names
   */
  async discoverPools() {
    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
      const poolListOutput = await safeExecuteCommand(
        () => executeZpoolList(timeout),
        'pool discovery',
        log.monitoring,
        this.hostname
      );

      if (!poolListOutput) {
        return new Set();
      }

      const pools = new Set();
      const lines = poolListOutput.trim().split('\n');

      for (const line of lines) {
        const poolName = line.trim();
        if (poolName) {
          pools.add(poolName);
          this.discoveryCache.addPool(poolName);
        }
      }

      return pools;
    } catch (error) {
      log.monitoring.warn('Failed to discover pools dynamically', {
        error: error.message,
        hostname: this.hostname,
      });
      return new Set();
    }
  }

  /**
   * Discover actual zone names from the system
   * @description Uses zoneadm list to get real zone names instead of hardcoded patterns
   * @returns {Promise<Set>} Set of discovered zone names
   */
  async discoverZones() {
    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
      const zoneListOutput = await safeExecuteCommand(
        () => executeZoneList(timeout),
        'zone discovery',
        log.monitoring,
        this.hostname
      );

      if (!zoneListOutput) {
        return new Set();
      }

      const zones = new Set();
      const lines = zoneListOutput.trim().split('\n');

      // Skip header line
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) {
          continue;
        }

        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          const [, zoneName] = parts; // Use array destructuring
          if (zoneName && zoneName !== 'global') {
            zones.add(zoneName);
            this.discoveryCache.addZone(zoneName);
          }
        }
      }

      return zones;
    } catch (error) {
      log.monitoring.warn('Failed to discover zones dynamically', {
        error: error.message,
        hostname: this.hostname,
      });
      return new Set();
    }
  }

  /**
   * Collect ZFS pool information
   * @description Gathers pool I/O statistics and status
   * @returns {Promise<Array>} Array of pool data objects
   */
  collectPoolData() {
    return this.poolCollector.collectPoolData();
  }

  /**
   * Collect extended ZFS pool information
   * @description Gathers additional pool information using various zpool commands
   * @returns {Promise<Array>} Array of extended pool data objects
   */
  collectExtendedPoolData() {
    return this.poolCollector.collectExtendedPoolData();
  }

  /**
   * Collect ZFS dataset information for zones/VMs only
   * @description Gathers dataset list and detailed properties for zone-related datasets only
   * @returns {Promise<Array>} Array of dataset data objects
   */
  async collectDatasetData() {
    const discoveredZones = await this.discoverZones();
    return this.datasetCollector.collectDatasetData(discoveredZones);
  }

  /**
   * Collect disk inventory information
   * @description Gathers physical disk information using format command
   * @returns {Promise<Array>} Array of disk data objects
   */
  collectDiskData() {
    return this.diskCollector.collectDiskData();
  }

  /**
   * Collect ZFS ARC statistics
   * @description Gathers ARC cache performance metrics using kstat
   * @returns {Promise<Object|null>} ARC statistics object or null on failure
   */
  collectARCStats() {
    return this.arcCollector.collectARCStats();
  }

  /**
   * Collect comprehensive I/O statistics (BOTH pool and disk level)
   * @description Single efficient call to get both pool and disk performance data
   * @returns {Promise<Object>} Object containing both poolStats and diskStats arrays
   */
  async collectComprehensiveIOStats() {
    const discoveredPools = await this.discoverPools();
    return this.ioStatsCollector.collectComprehensiveIOStats(discoveredPools);
  }

  /**
   * Collect frequent storage metrics (I/O and ARC stats)
   * @description Collects high-frequency metrics using efficient single command approach
   * @returns {Promise<boolean>} Success status
   */
  async collectFrequentStorageMetrics() {
    try {
      const discoveredPools = await this.discoverPools();
      return this.ioStatsCollector.collectFrequentStorageMetrics(
        discoveredPools,
        this.arcCollector
      );
    } catch (error) {
      const shouldContinue = await this.handleError(error, 'Frequent storage metrics collection');
      return shouldContinue;
    }
  }

  /**
   * Collect all storage information
   * @description Main entry point for storage data collection with parallel execution
   * @returns {Promise<boolean>} Success status
   */
  async collectStorageData() {
    if (this.isCollecting) {
      return true; // Already collecting, consider this successful
    }

    this.isCollecting = true;

    try {
      // Collect all storage data in parallel for optimal performance
      const [poolData, extendedPoolData, datasetData, diskData] = await Promise.all([
        this.collectPoolData().catch(error => {
          log.monitoring.warn('Pool data collection failed', {
            error: error.message,
            hostname: this.hostname,
          });
          return [];
        }),
        this.collectExtendedPoolData().catch(error => {
          log.monitoring.warn('Extended pool data collection failed', {
            error: error.message,
            hostname: this.hostname,
          });
          return [];
        }),
        this.collectDatasetData().catch(error => {
          log.monitoring.warn('Dataset data collection failed', {
            error: error.message,
            hostname: this.hostname,
          });
          return [];
        }),
        this.collectDiskData().catch(error => {
          log.monitoring.warn('Disk data collection failed', {
            error: error.message,
            hostname: this.hostname,
          });
          return [];
        }),
      ]);

      // Log collection success with stats for monitoring
      log.monitoring.debug('Storage data collection completed', {
        pool_data_count: poolData.length,
        extended_pool_data_count: extendedPoolData.length,
        dataset_data_count: datasetData.length,
        disk_data_count: diskData.length,
        hostname: this.hostname,
      });

      await this.updateHostInfo({ last_storage_scan: new Date() });
      await this.resetErrorCount();

      return true;
    } catch (error) {
      const shouldContinue = await this.handleError(error, 'Storage data collection');
      if (!shouldContinue) {
        this.isCollecting = false;
        return false;
      }
    } finally {
      this.isCollecting = false;
    }

    return true;
  }

  /**
   * Clean up old storage data based on retention policies
   */
  async cleanupOldData() {
    try {
      const retentionConfig = this.hostMonitoringConfig.retention;
      const now = new Date();

      // Clean pool data
      const poolRetentionDate = new Date(
        now.getTime() - retentionConfig.storage * 24 * 60 * 60 * 1000
      );
      const deletedPools = await ZFSPools.destroy({
        where: {
          scan_timestamp: { [Op.lt]: poolRetentionDate },
        },
      });

      // Clean dataset data
      const datasetRetentionDate = new Date(
        now.getTime() - retentionConfig.storage * 24 * 60 * 60 * 1000
      );
      const deletedDatasets = await ZFSDatasets.destroy({
        where: {
          scan_timestamp: { [Op.lt]: datasetRetentionDate },
        },
      });

      // Clean disk data
      const deletedDisks = await Disks.destroy({
        where: {
          scan_timestamp: { [Op.lt]: datasetRetentionDate },
        },
      });

      // Clean disk I/O stats
      const deletedDiskIO = await DiskIOStats.destroy({
        where: {
          scan_timestamp: { [Op.lt]: poolRetentionDate },
        },
      });

      // Clean pool I/O stats
      const deletedPoolIO = await PoolIOStats.destroy({
        where: {
          scan_timestamp: { [Op.lt]: poolRetentionDate },
        },
      });

      // Clean ARC stats
      const deletedARC = await ARCStats.destroy({
        where: {
          scan_timestamp: { [Op.lt]: poolRetentionDate },
        },
      });

      if (
        deletedPools > 0 ||
        deletedDatasets > 0 ||
        deletedDisks > 0 ||
        deletedDiskIO > 0 ||
        deletedPoolIO > 0 ||
        deletedARC > 0
      ) {
        log.database.info('Storage cleanup completed', {
          deleted_pools: deletedPools,
          deleted_datasets: deletedDatasets,
          deleted_disks: deletedDisks,
          deleted_disk_io: deletedDiskIO,
          deleted_pool_io: deletedPoolIO,
          deleted_arc: deletedARC,
          hostname: this.hostname,
        });
      }
    } catch (error) {
      log.database.error('Failed to cleanup old storage data', {
        error: error.message,
        hostname: this.hostname,
      });
    }
  }
}

export default StorageCollector;
