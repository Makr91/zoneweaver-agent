/**
 * @fileoverview I/O Statistics Collection Module
 * @description Handles comprehensive I/O statistics collection for pools and disks
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import DiskIOStats from '../../models/DiskIOStatsModel.js';
import PoolIOStats from '../../models/PoolIOStatsModel.js';
import { log } from '../../lib/Logger.js';
import { parseComprehensiveIOStats } from './utils/ParsingUtils.js';
import { executeComprehensiveIostat, safeExecuteCommand } from './utils/CommandUtils.js';
import { BatchProcessor } from './utils/HostUtils.js';

/**
 * I/O Statistics Collector Class
 * @description Handles collection of comprehensive I/O statistics for both pools and disks
 */
class IOStatsCollector {
  constructor(hostname, hostMonitoringConfig) {
    this.hostname = hostname;
    this.hostMonitoringConfig = hostMonitoringConfig;
    this.batchProcessor = new BatchProcessor(hostMonitoringConfig.performance.batch_size);
  }

  /**
   * Collect comprehensive I/O statistics (BOTH pool and disk level)
   * @description Single efficient call to get both pool and disk performance data
   * @param {Set} discoveredPools - Set of discovered pool names
   * @returns {Promise<Object>} Object containing both poolStats and diskStats arrays
   */
  async collectComprehensiveIOStats(discoveredPools) {
    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;

      // Single call to get BOTH pool and disk performance data with latency
      // Use -H for script-friendly output and 1 2 to get real-time data (second sample)
      const iostatOutput = await safeExecuteCommand(
        () => executeComprehensiveIostat(timeout),
        'comprehensive I/O statistics collection',
        log.monitoring,
        this.hostname
      );

      if (!iostatOutput) {
        return { poolStats: [], diskStats: [] };
      }

      const { poolStats, diskStats } = parseComprehensiveIOStats(
        iostatOutput,
        this.hostname,
        discoveredPools
      );

      // Store pool I/O data using batch processing
      if (poolStats.length > 0) {
        await this.batchProcessor.processBatches(poolStats, batch => PoolIOStats.bulkCreate(batch));
      }

      // Store disk I/O data using batch processing
      if (diskStats.length > 0) {
        await this.batchProcessor.processBatches(diskStats, batch => DiskIOStats.bulkCreate(batch));
      }

      return { poolStats, diskStats };
    } catch (error) {
      log.monitoring.error('Failed to collect comprehensive I/O statistics', {
        error: error.message,
        hostname: this.hostname,
      });
      throw error;
    }
  }

  /**
   * Collect frequent storage metrics (I/O and ARC stats)
   * @description Collects high-frequency metrics using efficient single command approach
   * @param {Set} discoveredPools - Set of discovered pool names
   * @param {Object} arcCollector - ARC collector instance
   * @returns {Promise<boolean>} Success status
   */
  async collectFrequentStorageMetrics(discoveredPools, arcCollector) {
    try {
      // SINGLE EFFICIENT CALL: Collect both pool + disk I/O performance
      const { poolStats, diskStats } = await this.collectComprehensiveIOStats(discoveredPools);

      // Collect ARC statistics (every minute)
      const arcStatsData = await arcCollector.collectARCStats();

      // Log collection success with stats for monitoring
      log.monitoring.debug('Frequent storage metrics collection completed', {
        pool_stats_count: poolStats.length,
        disk_stats_count: diskStats.length,
        arc_stats_collected: !!arcStatsData,
        hostname: this.hostname,
      });

      return true;
    } catch (error) {
      log.monitoring.error('Failed to collect frequent storage metrics', {
        error: error.message,
        hostname: this.hostname,
      });
      throw error;
    }
  }
}

export default IOStatsCollector;
