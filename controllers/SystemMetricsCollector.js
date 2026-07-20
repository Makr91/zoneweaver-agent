/**
 * @fileoverview System Metrics Data Collection Controller for Zoneweaver Agent
 * @description Collects CPU and memory statistics from OmniOS system utilities
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import os from 'os';
import config from '../config/ConfigLoader.js';
import CPUStats from '../models/CPUStatsModel.js';
import MemoryStats from '../models/MemoryStatsModel.js';
import SwapArea from '../models/SwapAreaModel.js';
import ZoneMetrics from '../models/ZoneMetricsModel.js';
import HostInfo from '../models/HostInfoModel.js';
import { Op } from 'sequelize';
import { log, createTimer } from '../lib/Logger.js';
import {
  collectCPUStats,
  collectMemoryStats,
  collectZoneMetrics,
} from './SystemMetricsCollector/collectors.js';
import { parseSwapListOutput } from './SystemMetricsCollector/parsers.js';

const execProm = util.promisify(exec);

/**
 * System Metrics Data Collector Class
 * @description Handles collection of CPU and memory performance data
 */
class SystemMetricsCollector {
  constructor() {
    this.hostMonitoringConfig = config.getHostMonitoring();
    this.hostname = os.hostname();
    this.isCollecting = false;
    this.errorCount = 0;
    this.lastErrorReset = Date.now();
    this.lastCPUTimes = null;
  }

  /**
   * Update host information record
   * @param {Object} updates - Fields to update
   */
  async updateHostInfo(updates) {
    try {
      await HostInfo.upsert({
        host: this.hostname,
        hostname: this.hostname,
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
        hostname: this.hostname,
        updates: Object.keys(updates),
      });
    }
  }

  /**
   * Handle collection errors
   * @param {Error} error - The error that occurred
   * @param {string} operation - The operation that failed
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

    log.monitoring.error('System metrics collection error', {
      error: error.message,
      operation,
      error_count: this.errorCount,
      max_errors: maxErrors,
      hostname: this.hostname,
    });

    await this.updateHostInfo({
      system_scan_errors: this.errorCount,
      last_error_message: errorMessage,
    });

    if (this.errorCount >= maxErrors) {
      log.monitoring.error('System metrics collector disabled due to consecutive errors', {
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
      await this.updateHostInfo({
        system_scan_errors: 0,
        last_error_message: null,
      });
    }
  }

  /**
   * Collect detailed swap area information
   * @returns {Promise<boolean>} Success status
   */
  async collectSwapAreas() {
    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;

      // Get detailed swap area information
      const { stdout: swapListOutput } = await execProm('pfexec swap -l', { timeout });
      const swapAreas = parseSwapListOutput(swapListOutput);

      if (swapAreas.length === 0) {
        log.monitoring.warn('No swap areas found in swap -l output', {
          hostname: this.hostname,
        });
        return true; // Not necessarily an error
      }

      // Get current active swap devices for this host
      const currentSwapDevices = new Set();

      // Use proper upsert with unique constraint on (host, swapfile) - parallel processing
      const upsertPromises = swapAreas.map(swapArea => {
        currentSwapDevices.add(swapArea.swapfile);

        return SwapArea.upsert(
          {
            host: this.hostname,
            ...swapArea,
          },
          {
            conflictFields: ['host', 'swapfile'],
          }
        );
      });

      await Promise.all(upsertPromises);

      // Drop rows for swap areas that vanished since the last scan — the table
      // only ever holds the CURRENT swap configuration (no is_active soft flag)
      if (currentSwapDevices.size > 0) {
        await SwapArea.destroy({
          where: {
            host: this.hostname,
            swapfile: { [Op.notIn]: [...currentSwapDevices] },
          },
        });
      }

      log.monitoring.debug('Swap area collection completed', {
        count: swapAreas.length,
        hostname: this.hostname,
      });

      await this.updateHostInfo({
        last_swap_scan: new Date(),
      });

      return true;
    } catch (error) {
      const shouldContinue = await this.handleError(error, 'Swap area collection');
      return shouldContinue;
    }
  }

  /**
   * Collect CPU, memory, and swap statistics in parallel
   * @returns {Promise<boolean>} Success status
   */
  async collectSystemMetrics() {
    try {
      // Collect all system metrics in parallel for optimal performance
      const [cpuSuccess, memorySuccess, swapSuccess, zoneSuccess] = await Promise.all([
        collectCPUStats(this).catch(error => {
          log.monitoring.warn('CPU stats collection failed', {
            error: error.message,
            hostname: this.hostname,
          });
          return false;
        }),
        collectMemoryStats(this).catch(error => {
          log.monitoring.warn('Memory stats collection failed', {
            error: error.message,
            hostname: this.hostname,
          });
          return false;
        }),
        this.collectSwapAreas().catch(error => {
          log.monitoring.warn('Swap areas collection failed', {
            error: error.message,
            hostname: this.hostname,
          });
          return false;
        }),
        collectZoneMetrics(this).catch(error => {
          log.monitoring.warn('Zone metrics collection failed', {
            error: error.message,
            hostname: this.hostname,
          });
          return false;
        }),
      ]);

      if (cpuSuccess && memorySuccess && swapSuccess && zoneSuccess) {
        await this.resetErrorCount();
        return true;
      }
      log.monitoring.warn('System metrics collection completed with some errors', {
        cpu_success: cpuSuccess,
        memory_success: memorySuccess,
        swap_success: swapSuccess,
        zone_success: zoneSuccess,
        hostname: this.hostname,
      });
      return false;
    } catch (error) {
      const shouldContinue = await this.handleError(error, 'System metrics collection');
      return shouldContinue;
    }
  }

  /**
   * Clean up old system metrics data based on retention policies
   */
  async cleanupOldData() {
    const timer = createTimer('system_metrics_cleanup');
    try {
      const retentionConfig = this.hostMonitoringConfig.retention;
      const now = new Date();

      // Clean CPU data
      const cpuRetentionDate = new Date(
        now.getTime() - retentionConfig.cpu_stats * 24 * 60 * 60 * 1000
      );
      const deletedCPU = await CPUStats.destroy({
        where: {
          scan_timestamp: { [Op.lt]: cpuRetentionDate },
        },
      });

      // Clean memory data
      const memoryRetentionDate = new Date(
        now.getTime() - retentionConfig.memory_stats * 24 * 60 * 60 * 1000
      );
      const deletedMemory = await MemoryStats.destroy({
        where: {
          scan_timestamp: { [Op.lt]: memoryRetentionDate },
        },
      });

      // Clean swap areas data
      const swapRetentionDate = new Date(
        now.getTime() - retentionConfig.system_metrics * 24 * 60 * 60 * 1000
      );
      const deletedSwapAreas = await SwapArea.destroy({
        where: {
          scan_timestamp: { [Op.lt]: swapRetentionDate },
        },
      });

      // Clean per-zone metrics (same retention window as system metrics)
      const deletedZoneMetrics = await ZoneMetrics.destroy({
        where: {
          scan_timestamp: { [Op.lt]: swapRetentionDate },
        },
      });

      const duration = timer.end();

      if (deletedCPU > 0 || deletedMemory > 0 || deletedSwapAreas > 0 || deletedZoneMetrics > 0) {
        log.database.info('System metrics cleanup completed', {
          deleted_cpu: deletedCPU,
          deleted_memory: deletedMemory,
          deleted_swap_areas: deletedSwapAreas,
          deleted_zone_metrics: deletedZoneMetrics,
          duration_ms: duration,
          hostname: this.hostname,
        });
      }
    } catch (error) {
      timer.end();
      log.database.error('Failed to cleanup old system metrics data', {
        error: error.message,
        hostname: this.hostname,
      });
    }
  }
}

export default SystemMetricsCollector;
