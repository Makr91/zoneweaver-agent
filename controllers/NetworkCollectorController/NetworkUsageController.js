/**
 * @fileoverview Network Usage Controller
 * @description Handles network usage data collection, bandwidth calculations, and utilization tracking
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import { Op } from 'sequelize';
import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import NetworkUsage from '../../models/NetworkUsageModel.js';
import NetworkParsingController from './NetworkParsingController.js';
import { log } from '../../lib/Logger.js';
import {
  calculateBandwidthUtilization,
  calculateDeltaValues,
  calculateInstantaneousBandwidth,
  createUsageRecord,
} from './NetworkUsageCalculations.js';
import {
  collectSingleInterfaceUsage,
  correlateUsageWithInterfaces,
  findPossibleFullInterfaceNames,
} from './NetworkUsageCorrelation.js';

const execProm = util.promisify(exec);

/**
 * Network Usage Controller Class
 * @description Manages network usage data collection and bandwidth calculations
 */
export class NetworkUsageController {
  constructor(hostMonitoringConfig, hostManager) {
    this.hostMonitoringConfig = hostMonitoringConfig;
    this.hostManager = hostManager;
    this.parser = new NetworkParsingController();
  }

  /**
   * Check if interface name appears to be truncated and find matches
   * @param {string} linkName - The interface name from usage output
   * @param {Array} allInterfaces - All known interfaces from configuration
   * @returns {Array} Array of possible full interface names
   */
  findPossibleFullInterfaceNames(linkName, allInterfaces) {
    return findPossibleFullInterfaceNames(linkName, allInterfaces);
  }

  /**
   * Correlate usage data with full interface names
   * @param {Array} usageData - Usage data with potentially truncated names
   * @param {Array} allInterfaces - All known interfaces from configuration
   * @returns {Array} Usage data with correlation information
   */
  correlateUsageWithInterfaces(usageData, allInterfaces) {
    return correlateUsageWithInterfaces(usageData, allInterfaces);
  }

  /**
   * Collect network usage data for a specific interface
   * @param {string} interfaceName - The full interface name
   * @param {string} acctFile - Path to accounting file
   * @param {number} timeout - Command timeout in milliseconds
   * @returns {Object|null} Usage data for the interface
   */
  collectSingleInterfaceUsage(interfaceName, acctFile, timeout) {
    return collectSingleInterfaceUsage(interfaceName, acctFile, timeout, this.parser);
  }

  /**
   * Calculate bandwidth utilization percentage
   * @param {string} bytes - Bytes transferred
   * @param {number} speedMbps - Interface speed in Mbps
   * @param {number} timePeriod - Time period in seconds
   * @returns {number|null} Utilization percentage
   */
  calculateBandwidthUtilization(bytes, speedMbps, timePeriod) {
    return calculateBandwidthUtilization(bytes, speedMbps, timePeriod, this.parser.hostname);
  }

  /**
   * Calculate instantaneous bandwidth from byte counters
   * @param {Object} currentStats - Current interface statistics
   * @param {Object} previousStats - Previous interface statistics
   * @returns {Object} Calculated bandwidth information
   */
  calculateInstantaneousBandwidth(currentStats, previousStats) {
    return calculateInstantaneousBandwidth(currentStats, previousStats, this.parser.hostname);
  }

  /**
   * Get interface configuration mappings for speed lookups
   * @returns {Map} Map of interface configurations
   */
  async getInterfaceConfigs() {
    try {
      const interfaceConfigs = await NetworkInterfaces.findAll({
        where: { host: this.parser.hostname },
        attributes: ['link', 'speed', 'class'],
        order: [['scan_timestamp', 'DESC']],
        limit: 1000,
      });

      const speedMap = new Map();
      interfaceConfigs.forEach(iface => {
        const { link, speed, class: ifaceClass } = iface;
        if (!speedMap.has(link) && speed) {
          speedMap.set(link, {
            speed,
            class: ifaceClass,
          });
        }
      });
      return speedMap;
    } catch (error) {
      log.database.warn('Could not fetch interface configuration for speed data', {
        error: error.message,
        hostname: this.parser.hostname,
      });
      return new Map();
    }
  }

  /**
   * Get previous usage statistics for bandwidth calculations
   * @param {number} interfaceCount - Number of interfaces to account for
   * @returns {Map} Map of previous statistics
   */
  async getPreviousUsageStats(interfaceCount) {
    try {
      const collectionInterval = this.hostMonitoringConfig.intervals.network_usage || 20;
      const minPreviousAge = new Date(Date.now() - (collectionInterval - 2) * 1000);

      const previousStats = await NetworkUsage.findAll({
        where: {
          host: this.parser.hostname,
          scan_timestamp: { [Op.lt]: minPreviousAge },
        },
        order: [['scan_timestamp', 'DESC']],
        limit: interfaceCount * 3,
      });

      const grouped = new Map();
      previousStats.forEach(stat => {
        const { link } = stat;
        if (!grouped.has(link)) {
          grouped.set(link, stat);
        }
      });

      log.monitoring.debug('Previous usage records found', {
        previous_records: grouped.size,
        current_interfaces: interfaceCount,
        hostname: this.parser.hostname,
      });

      return grouped;
    } catch (error) {
      log.database.warn('Could not fetch previous usage statistics', {
        error: error.message,
        hostname: this.parser.hostname,
      });
      return new Map();
    }
  }

  /**
   * Calculate delta values between current and previous stats
   * @param {Object} currentStat - Current interface statistics
   * @param {Object} previousStat - Previous interface statistics
   * @returns {Object} Delta values
   */
  calculateDeltaValues(currentStat, previousStat) {
    return calculateDeltaValues(currentStat, previousStat);
  }

  /**
   * Create usage record from statistics
   * @param {Object} currentStat - Current interface statistics
   * @param {Object} previousStat - Previous interface statistics
   * @param {Object} interfaceConfig - Interface configuration
   * @returns {Object} Usage record
   */
  createUsageRecord(currentStat, previousStat, interfaceConfig) {
    return createUsageRecord(currentStat, previousStat, interfaceConfig, this.parser.hostname);
  }

  /**
   * Store usage data in database with batch processing
   * @param {Array} usageDataResults - Usage data to store
   */
  async storeUsageData(usageDataResults) {
    if (usageDataResults.length === 0) {
      return;
    }

    const batchSize = this.hostMonitoringConfig.performance.batch_size;
    const batches = [];
    for (let i = 0; i < usageDataResults.length; i += batchSize) {
      const batch = usageDataResults.slice(i, i + batchSize);
      batches.push(NetworkUsage.bulkCreate(batch));
    }
    await Promise.all(batches);

    await this.hostManager.updateHostInfo({ last_network_usage_scan: new Date() });

    const activeBandwidth = usageDataResults.filter(u => u.rx_mbps > 0 || u.tx_mbps > 0);
    if (activeBandwidth.length > 0) {
      log.monitoring.debug('Active network bandwidth detected', {
        active_interfaces: activeBandwidth.length,
        total_interfaces: usageDataResults.length,
        hostname: this.parser.hostname,
      });
    }
  }

  /**
   * Collect network usage data using link statistics
   * @description Gathers usage data from dladm show-link -s and calculates bandwidth utilization
   */
  async collectNetworkUsage() {
    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;

      const { stdout } = await execProm(
        'dladm show-link -s -p -o link,ipackets,rbytes,ierrors,opackets,obytes,oerrors',
        { timeout }
      );
      const currentStats = this.parser.parseStatsOutput(stdout);

      if (currentStats.length === 0) {
        return true;
      }

      const interfaceConfigs = await this.getInterfaceConfigs();
      const previousStatsMap = await this.getPreviousUsageStats(interfaceConfigs.size);

      const usageDataResults = [];

      for (const currentStat of currentStats) {
        const interfaceConfig = interfaceConfigs.get(currentStat.link);
        const previousStat = previousStatsMap.get(currentStat.link);

        const usageRecord = this.createUsageRecord(currentStat, previousStat, interfaceConfig);
        usageDataResults.push(usageRecord);
      }

      await this.storeUsageData(usageDataResults);

      await this.hostManager.resetErrorCount();
      return true;
    } catch (error) {
      const shouldContinue = await this.hostManager.handleError(error, 'Network usage collection');
      return shouldContinue;
    }
  }
}

export default NetworkUsageController;
