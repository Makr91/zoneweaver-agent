/**
 * @fileoverview Network Host Manager Utility
 * @description Handles host information management and error tracking for network operations
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import os from 'os';
import HostInfo from '../../../models/HostInfoModel.js';
import { log } from '../../../lib/Logger.js';

/**
 * Network Host Manager Class
 * @description Manages host information updates and error handling for network collection
 */
export class NetworkHostManager {
  constructor(hostMonitoringConfig) {
    this.hostMonitoringConfig = hostMonitoringConfig;
    this.hostname = os.hostname();
    this.errorCount = 0;
    this.lastErrorReset = Date.now();
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
   * @returns {boolean} True to continue collecting, false to disable collector
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

    log.monitoring.error('Network collection error', {
      error: error.message,
      operation,
      error_count: this.errorCount,
      max_errors: maxErrors,
      hostname: this.hostname,
    });

    await this.updateHostInfo({
      network_scan_errors: this.errorCount,
      last_error_message: errorMessage,
    });

    if (this.errorCount >= maxErrors) {
      log.monitoring.error('Network collector disabled due to consecutive errors', {
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
        network_scan_errors: 0,
        last_error_message: null,
      });
    }
  }
}

export default NetworkHostManager;
