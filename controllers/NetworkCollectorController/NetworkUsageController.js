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
    // If the link name already exists exactly, return it
    if (allInterfaces.some(iface => iface.link === linkName)) {
      return [linkName];
    }

    // Find interfaces that start with this truncated name
    const matches = allInterfaces
      .filter(iface => iface.link.startsWith(linkName))
      .map(iface => iface.link);

    return matches.length > 0 ? matches : [linkName];
  }

  /**
   * Correlate usage data with full interface names
   * @param {Array} usageData - Usage data with potentially truncated names
   * @param {Array} allInterfaces - All known interfaces from configuration
   * @returns {Array} Usage data with correlation information
   */
  correlateUsageWithInterfaces(usageData, allInterfaces) {
    const correlatedData = [];
    const usageGrouped = new Map();

    // Group usage entries by link name
    usageData.forEach(usage => {
      if (!usageGrouped.has(usage.link)) {
        usageGrouped.set(usage.link, []);
      }
      usageGrouped.get(usage.link).push(usage);
    });

    // Process each unique link name
    usageGrouped.forEach((usageEntries, linkName) => {
      const possibleMatches = this.findPossibleFullInterfaceNames(linkName, allInterfaces);

      if (possibleMatches.length === 1) {
        // Direct match or exact truncated name
        usageEntries.forEach(usage => {
          correlatedData.push({
            ...usage,
            full_interface_name: possibleMatches[0],
            is_truncated: possibleMatches[0] !== linkName,
            match_confidence: 'high',
          });
        });
      } else if (possibleMatches.length > 1) {
        // Multiple possible matches - this indicates truncation
        // Distribute the usage entries among the possible matches
        usageEntries.forEach((usage, index) => {
          if (index < possibleMatches.length) {
            // Assign to a specific interface
            correlatedData.push({
              ...usage,
              full_interface_name: possibleMatches[index],
              is_truncated: true,
              match_confidence: 'medium',
              truncation_note: `One of ${possibleMatches.length} possible matches: ${possibleMatches.join(', ')}`,
            });
          } else {
            // Extra entries get assigned to first interface with a note
            correlatedData.push({
              ...usage,
              full_interface_name: possibleMatches[0],
              is_truncated: true,
              match_confidence: 'low',
              truncation_note: `Extra entry - may represent aggregated data for: ${possibleMatches.join(', ')}`,
            });
          }
        });
      } else {
        // No matches found - keep original
        usageEntries.forEach(usage => {
          correlatedData.push({
            ...usage,
            full_interface_name: linkName,
            is_truncated: false,
            match_confidence: 'unknown',
          });
        });
      }
    });

    return correlatedData;
  }

  /**
   * Collect network usage data for a specific interface
   * @param {string} interfaceName - The full interface name
   * @param {string} acctFile - Path to accounting file
   * @param {number} timeout - Command timeout in milliseconds
   * @returns {Object|null} Usage data for the interface
   */
  async collectSingleInterfaceUsage(interfaceName, acctFile, timeout) {
    try {
      // Try summary data first (without -a flag)
      let stdout;
      try {
        const { stdout: resultStdout } = await execProm(
          `pfexec dladm show-usage -f ${acctFile} ${interfaceName}`,
          {
            timeout,
          }
        );
        stdout = resultStdout;
      } catch (summaryError) {
        // If summary fails, try with -a flag to get all records
        if (
          summaryError.message.includes('no records') ||
          summaryError.message.includes('not found')
        ) {
          return null;
        }

        // Try with -a flag for detailed records
        try {
          const { stdout: detailedStdout } = await execProm(
            `pfexec dladm show-usage -a -f ${acctFile} ${interfaceName}`,
            { timeout }
          );
          stdout = detailedStdout;
        } catch (detailedError) {
          if (
            detailedError.message.includes('no records') ||
            detailedError.message.includes('not found')
          ) {
            return null;
          }
          throw detailedError;
        }
      }

      if (!stdout || !stdout.trim()) {
        return null; // No usage data for this interface
      }

      // Parse the output
      const usageData = this.parser.parseUsageOutput(stdout);

      if (usageData.length > 0) {
        // Override the potentially truncated link name with the actual interface name
        const [usage] = usageData; // Take the first entry
        usage.link = interfaceName; // Use the full interface name we queried
        return usage;
      }

      return null;
    } catch (error) {
      // Interface might not have usage data yet, which is normal
      if (
        error.message.includes('no records') ||
        error.message.includes('not found') ||
        error.message.includes('invalid link')
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Calculate bandwidth utilization percentage
   * @param {string} bytes - Bytes transferred
   * @param {number} speedMbps - Interface speed in Mbps
   * @param {number} timePeriod - Time period in seconds
   * @returns {number|null} Utilization percentage
   */
  calculateBandwidthUtilization(bytes, speedMbps, timePeriod) {
    if (!bytes || !speedMbps || !timePeriod || speedMbps === 0) {
      return null;
    }

    const bytesNum = parseInt(bytes) || 0;

    // Validate inputs to prevent NaN
    if (isNaN(bytesNum) || isNaN(speedMbps) || isNaN(timePeriod)) {
      log.monitoring.debug('Invalid inputs in bandwidth utilization calculation', {
        bytes,
        speedMbps,
        timePeriod,
        hostname: this.parser.hostname,
      });
      return null;
    }

    const bitsTransferred = bytesNum * 8; // Convert bytes to bits
    const maxBits = speedMbps * 1000000 * timePeriod; // Max bits in time period

    if (maxBits === 0) {
      return null;
    }

    const utilization = (bitsTransferred / maxBits) * 100;

    // Validate result to prevent NaN
    if (isNaN(utilization)) {
      log.monitoring.warn('NaN result in bandwidth utilization calculation', {
        bytes,
        speedMbps,
        timePeriod,
        hostname: this.parser.hostname,
      });
      return null;
    }

    return Math.round(utilization * 100) / 100; // Round to 2 decimal places
  }

  /**
   * Calculate instantaneous bandwidth from byte counters
   * @param {Object} currentStats - Current interface statistics
   * @param {Object} previousStats - Previous interface statistics
   * @returns {Object} Calculated bandwidth information
   */
  calculateInstantaneousBandwidth(currentStats, previousStats) {
    if (!previousStats) {
      return {
        rx_bps: null,
        tx_bps: null,
        rx_mbps: null,
        tx_mbps: null,
        time_delta: null,
      };
    }

    // Ensure timestamps are valid Date objects
    const currentTime = new Date(currentStats.scan_timestamp).getTime();
    const previousTime = new Date(previousStats.scan_timestamp).getTime();

    if (isNaN(currentTime) || isNaN(previousTime)) {
      log.monitoring.debug('Invalid timestamps in bandwidth calculation', {
        current_time: currentTime,
        previous_time: previousTime,
        hostname: this.parser.hostname,
      });
      return {
        rx_bps: null,
        tx_bps: null,
        rx_mbps: null,
        tx_mbps: null,
        time_delta: null,
      };
    }

    const timeDelta = (currentTime - previousTime) / 1000; // seconds

    if (timeDelta <= 0) {
      return {
        rx_bps: null,
        tx_bps: null,
        rx_mbps: null,
        tx_mbps: null,
        time_delta: timeDelta,
      };
    }

    // Parse byte counters safely
    const currentRxBytes = parseInt(currentStats.rbytes) || 0;
    const previousRxBytes = parseInt(previousStats.rbytes) || 0;
    const currentTxBytes = parseInt(currentStats.obytes) || 0;
    const previousTxBytes = parseInt(previousStats.obytes) || 0;

    const rxBytes = Math.max(0, currentRxBytes - previousRxBytes);
    const txBytes = Math.max(0, currentTxBytes - previousTxBytes);

    const rxBps = rxBytes / timeDelta; // bytes per second
    const txBps = txBytes / timeDelta; // bytes per second

    // Validate calculated values and ensure they're not NaN
    const safeRxBps = isNaN(rxBps) ? null : Math.round(Math.max(0, rxBps));
    const safeTxBps = isNaN(txBps) ? null : Math.round(Math.max(0, txBps));
    const safeRxMbps =
      safeRxBps !== null ? Math.round(((safeRxBps * 8) / 1000000) * 100) / 100 : null;
    const safeTxMbps =
      safeTxBps !== null ? Math.round(((safeTxBps * 8) / 1000000) * 100) / 100 : null;

    return {
      rx_bps: safeRxBps,
      tx_bps: safeTxBps,
      rx_mbps: safeRxMbps,
      tx_mbps: safeTxMbps,
      time_delta: timeDelta,
    };
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

      // Create map for quick lookup of interface speeds
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
      // Calculate minimum age for "previous" records (collection interval - 2 seconds buffer)
      const collectionInterval = this.hostMonitoringConfig.intervals.network_usage || 20;
      const minPreviousAge = new Date(Date.now() - (collectionInterval - 2) * 1000);

      const previousStats = await NetworkUsage.findAll({
        where: {
          host: this.parser.hostname,
          scan_timestamp: { [Op.lt]: minPreviousAge }, // Only get records older than collection interval
        },
        order: [['scan_timestamp', 'DESC']],
        limit: interfaceCount * 3, // Get more records to ensure we have data for all interfaces
      });

      // Group by interface and keep only the most recent "old" entry per interface
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
    const deltaValues = {
      ipackets_delta: null,
      rbytes_delta: null,
      ierrors_delta: null,
      opackets_delta: null,
      obytes_delta: null,
      oerrors_delta: null,
    };

    if (previousStat) {
      // Calculate deltas (difference from previous sample)
      const currentIPackets = parseInt(currentStat.ipackets) || 0;
      const previousIPackets = parseInt(previousStat.ipackets) || 0;
      deltaValues.ipackets_delta = Math.max(0, currentIPackets - previousIPackets);

      const currentRBytes = parseInt(currentStat.rbytes) || 0;
      const previousRBytes = parseInt(previousStat.rbytes) || 0;
      deltaValues.rbytes_delta = Math.max(0, currentRBytes - previousRBytes);

      const currentIErrors = parseInt(currentStat.ierrors) || 0;
      const previousIErrors = parseInt(previousStat.ierrors) || 0;
      deltaValues.ierrors_delta = Math.max(0, currentIErrors - previousIErrors);

      const currentOPackets = parseInt(currentStat.opackets) || 0;
      const previousOPackets = parseInt(previousStat.opackets) || 0;
      deltaValues.opackets_delta = Math.max(0, currentOPackets - previousOPackets);

      const currentOBytes = parseInt(currentStat.obytes) || 0;
      const previousOBytes = parseInt(previousStat.obytes) || 0;
      deltaValues.obytes_delta = Math.max(0, currentOBytes - previousOBytes);

      const currentOErrors = parseInt(currentStat.oerrors) || 0;
      const previousOErrors = parseInt(previousStat.oerrors) || 0;
      deltaValues.oerrors_delta = Math.max(0, currentOErrors - previousOErrors);
    }

    return deltaValues;
  }

  /**
   * Create usage record from statistics
   * @param {Object} currentStat - Current interface statistics
   * @param {Object} previousStat - Previous interface statistics
   * @param {Object} interfaceConfig - Interface configuration
   * @returns {Object} Usage record
   */
  createUsageRecord(currentStat, previousStat, interfaceConfig) {
    const deltaValues = this.calculateDeltaValues(currentStat, previousStat);
    const bandwidth = this.calculateInstantaneousBandwidth(currentStat, previousStat);

    // Calculate utilization if we have speed info - use delta bytes, not cumulative
    let rxUtilization = null;
    let txUtilization = null;

    if (interfaceConfig && interfaceConfig.speed && bandwidth.time_delta && previousStat) {
      // Use delta values instead of cumulative counters for accurate utilization
      const { speed } = interfaceConfig;
      rxUtilization = this.calculateBandwidthUtilization(
        deltaValues.rbytes_delta,
        speed,
        bandwidth.time_delta
      );
      txUtilization = this.calculateBandwidthUtilization(
        deltaValues.obytes_delta,
        speed,
        bandwidth.time_delta
      );
    }

    // Validate and create usage record (ensure no NaN values)
    const safeValue = value => {
      if (value === null || value === undefined) {
        return null;
      }
      if (isNaN(value)) {
        log.monitoring.debug('NaN value detected in usage record', {
          interface: currentStat.link,
          value,
          hostname: this.parser.hostname,
        });
        return null;
      }
      return value;
    };

    return {
      host: this.parser.hostname,
      link: currentStat.link,

      // Raw counters (validated)
      ipackets: currentStat.ipackets || null,
      rbytes: currentStat.rbytes || null,
      ierrors: currentStat.ierrors || null,
      opackets: currentStat.opackets || null,
      obytes: currentStat.obytes || null,
      oerrors: currentStat.oerrors || null,

      // Delta values (validated)
      ipackets_delta: safeValue(deltaValues.ipackets_delta),
      rbytes_delta: safeValue(deltaValues.rbytes_delta),
      ierrors_delta: safeValue(deltaValues.ierrors_delta),
      opackets_delta: safeValue(deltaValues.opackets_delta),
      obytes_delta: safeValue(deltaValues.obytes_delta),
      oerrors_delta: safeValue(deltaValues.oerrors_delta),

      // Calculated bandwidth (validated)
      rx_bps: safeValue(bandwidth.rx_bps),
      tx_bps: safeValue(bandwidth.tx_bps),
      rx_mbps: safeValue(bandwidth.rx_mbps),
      tx_mbps: safeValue(bandwidth.tx_mbps),

      // Utilization percentages (validated)
      rx_utilization_pct: safeValue(rxUtilization),
      tx_utilization_pct: safeValue(txUtilization),

      // Interface information (validated)
      interface_speed_mbps:
        interfaceConfig && interfaceConfig.speed ? safeValue(interfaceConfig.speed) : null,
      interface_class: interfaceConfig ? interfaceConfig.class : null,

      // Metadata (validated)
      time_delta_seconds: safeValue(bandwidth.time_delta),
      scan_timestamp: new Date(),
    };
  }

  /**
   * Store usage data in database with batch processing
   * @param {Array} usageDataResults - Usage data to store
   */
  async storeUsageData(usageDataResults) {
    if (usageDataResults.length === 0) {
      return;
    }

    // Store in parallel batches
    const batchSize = this.hostMonitoringConfig.performance.batch_size;
    const batches = [];
    for (let i = 0; i < usageDataResults.length; i += batchSize) {
      const batch = usageDataResults.slice(i, i + batchSize);
      batches.push(NetworkUsage.bulkCreate(batch));
    }
    await Promise.all(batches);

    await this.hostManager.updateHostInfo({ last_network_usage_scan: new Date() });

    // Log some sample data for verification
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

      // Get current link statistics using parseable format
      const { stdout } = await execProm(
        'dladm show-link -s -p -o link,ipackets,rbytes,ierrors,opackets,obytes,oerrors',
        { timeout }
      );
      const currentStats = this.parser.parseStatsOutput(stdout);

      if (currentStats.length === 0) {
        return true;
      }

      // Get interface configurations and previous statistics
      const interfaceConfigs = await this.getInterfaceConfigs();
      const previousStatsMap = await this.getPreviousUsageStats(interfaceConfigs.size);

      const usageDataResults = [];

      // Process each interface's statistics
      for (const currentStat of currentStats) {
        const interfaceConfig = interfaceConfigs.get(currentStat.link);
        const previousStat = previousStatsMap.get(currentStat.link);

        const usageRecord = this.createUsageRecord(currentStat, previousStat, interfaceConfig);
        usageDataResults.push(usageRecord);
      }

      // Store collected usage data
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
