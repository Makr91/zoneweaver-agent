/**
 * @fileoverview ZFS Pool Data Collection Module
 * @description Handles ZFS pool information collection and processing
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import ZFSPools from '../../models/ZFSPoolModel.js';
import { log } from '../../lib/Logger.js';
import {
  parsePoolIostatOutput,
  parsePoolStatusOutput,
  parsePoolListOutput,
} from './utils/ParsingUtils.js';
import {
  executeZpoolIostat,
  executeZpoolStatus,
  executeZpoolListExtended,
  safeExecuteCommand,
} from './utils/CommandUtils.js';
import { BatchProcessor } from './utils/HostUtils.js';

/**
 * ZFS Pool Data Collector Class
 * @description Handles collection of ZFS pool information
 */
class PoolCollector {
  constructor(hostname, hostMonitoringConfig) {
    this.hostname = hostname;
    this.hostMonitoringConfig = hostMonitoringConfig;
    this.batchProcessor = new BatchProcessor(hostMonitoringConfig.performance.batch_size);
  }

  /**
   * Collect ZFS pool information
   * @description Gathers pool I/O statistics and status
   * @returns {Promise<Array>} Array of pool data objects
   */
  async collectPoolData() {
    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
      const allPools = [];

      // Collect pool iostat data
      const iostatData = await safeExecuteCommand(
        () => executeZpoolIostat(timeout),
        'pool iostat data collection',
        log.monitoring,
        this.hostname
      );

      if (iostatData) {
        const parsedIostatData = parsePoolIostatOutput(iostatData, this.hostname);
        allPools.push(...parsedIostatData);
      }

      // Collect pool status data
      const statusData = await safeExecuteCommand(
        () => executeZpoolStatus(timeout),
        'pool status data collection',
        log.monitoring,
        this.hostname
      );

      if (statusData) {
        const parsedStatusData = parsePoolStatusOutput(statusData, this.hostname);

        // Merge status data with iostat data
        parsedStatusData.forEach(statusPool => {
          const existing = allPools.find(
            pool => pool.pool === statusPool.pool && pool.scan_type === 'iostat'
          );
          if (existing) {
            Object.assign(existing, {
              health: statusPool.health,
              status: statusPool.status,
              errors: statusPool.errors,
            });
          } else {
            allPools.push(statusPool);
          }
        });
      }

      // Store pool data in database using batch processing
      if (allPools.length > 0) {
        await this.batchProcessor.processBatches(allPools, batch => ZFSPools.bulkCreate(batch));
      }

      return allPools;
    } catch (error) {
      log.monitoring.error('Failed to collect pool data', {
        error: error.message,
        hostname: this.hostname,
      });
      throw error;
    }
  }

  /**
   * Collect extended ZFS pool information
   * @description Gathers additional pool information using zpool list command
   * @returns {Promise<Array>} Array of extended pool data objects
   */
  async collectExtendedPoolData() {
    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
      const extendedData = [];

      // Collect zpool list output for detailed pool information
      const listOutput = await safeExecuteCommand(
        () => executeZpoolListExtended(timeout),
        'zpool list data collection',
        log.monitoring,
        this.hostname
      );

      if (listOutput) {
        const listData = parsePoolListOutput(listOutput, this.hostname);
        extendedData.push(...listData);
      }

      // Store extended pool data using batch processing
      if (extendedData.length > 0) {
        await this.batchProcessor.processBatches(extendedData, batch =>
          ZFSPools.bulkCreate(batch, {
            updateOnDuplicate: Object.keys(ZFSPools.rawAttributes).filter(key => key !== 'id'),
          })
        );
      }

      return extendedData;
    } catch (error) {
      log.monitoring.error('Failed to collect extended pool data', {
        error: error.message,
        hostname: this.hostname,
      });
      throw error;
    }
  }
}

export default PoolCollector;
