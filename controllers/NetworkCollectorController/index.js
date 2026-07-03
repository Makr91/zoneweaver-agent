/**
 * @fileoverview Network Collector Controller Index
 * @description Main entry point for modular network collection functionality
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import config from '../../config/ConfigLoader.js';
import NetworkAccountingController from './NetworkAccountingController.js';
import NetworkParsingController from './NetworkParsingController.js';
import NetworkConfigController from './NetworkConfigController.js';
import NetworkUsageController from './NetworkUsageController.js';
import NetworkDataController from './NetworkDataController.js';
import NetworkCleanupController from './NetworkCleanupController.js';
import NetworkHostManager from './utils/NetworkHostManager.js';

/**
 * Network Data Collector Class
 * @description Handles collection of network interface configuration, statistics, and usage data
 */
class NetworkCollector {
  constructor() {
    this.hostMonitoringConfig = config.getHostMonitoring();
    this.hostManager = new NetworkHostManager(this.hostMonitoringConfig);

    // Initialize modular controllers
    this.accountingController = new NetworkAccountingController(this.hostMonitoringConfig);
    this.parsingController = new NetworkParsingController();
    this.configController = new NetworkConfigController(
      this.hostMonitoringConfig,
      this.hostManager
    );
    this.usageController = new NetworkUsageController(this.hostMonitoringConfig, this.hostManager);
    this.dataController = new NetworkDataController(this.hostMonitoringConfig, this.hostManager);
    this.cleanupController = new NetworkCleanupController(this.hostMonitoringConfig);

    // Legacy compatibility properties
    this.hostname = this.hostManager.hostname;
    this.isCollecting = false;
    this.errorCount = 0;
    this.lastErrorReset = Date.now();
  }

  /**
   * Initialize network accounting if not already enabled
   * @description Enables network accounting using acctadm if auto_enable_network_accounting is true
   */
  initializeNetworkAccounting() {
    return this.accountingController.initializeNetworkAccounting();
  }

  /**
   * Update host information record
   * @param {Object} updates - Fields to update
   */
  updateHostInfo(updates) {
    return this.hostManager.updateHostInfo(updates);
  }

  /**
   * Handle collection errors
   * @param {Error} error - The error that occurred
   * @param {string} operation - The operation that failed
   */
  async handleError(error, operation) {
    const result = await this.hostManager.handleError(error, operation);
    // Update legacy properties for compatibility
    this.errorCount = this.hostManager.errorCount;
    this.lastErrorReset = this.hostManager.lastErrorReset;
    return result;
  }

  /**
   * Reset error count on successful operation
   */
  async resetErrorCount() {
    await this.hostManager.resetErrorCount();
    this.errorCount = 0;
  }

  /**
   * Parse dladm show-vnic output (parseable format)
   * @param {string} output - Command output from dladm show-vnic -p -o LINK,OVER,SPEED,MACADDRESS,MACADDRTYPE,VID,ZONE
   * @returns {Array} Parsed interface data
   */
  parseVnicParseable(output) {
    return this.parsingController.parseVnicParseable(output);
  }

  /**
   * Parse dladm show-vnic output (legacy table format)
   * @param {string} output - Command output
   * @returns {Array} Parsed interface data
   */
  parseVnicOutput(output) {
    return this.parsingController.parseVnicOutput(output);
  }

  /**
   * Parse dladm show-ether output
   * @param {string} output - Command output
   * @returns {Array} Parsed interface data
   */
  parseEtherOutput(output) {
    return this.parsingController.parseEtherOutput(output);
  }

  /**
   * Parse dladm show-phys output
   * @param {string} output - Command output
   * @returns {Array} Parsed interface data
   */
  parsePhysOutput(output) {
    return this.parsingController.parsePhysOutput(output);
  }

  /**
   * Parse dladm show-link output
   * @param {string} output - Command output
   * @returns {Array} Parsed interface data
   */
  parseLinkOutput(output) {
    return this.parsingController.parseLinkOutput(output);
  }

  /**
   * Parse dladm show-link -s -p output (parseable statistics)
   * @param {string} output - Command output from parseable format
   * @returns {Array} Parsed statistics data
   */
  parseStatsOutput(output) {
    return this.parsingController.parseStatsOutput(output);
  }

  /**
   * Parse dladm show-usage output
   * @param {string} output - Command output
   * @returns {Array} Parsed usage data
   */
  parseUsageOutput(output) {
    return this.parsingController.parseUsageOutput(output);
  }

  /**
   * Parse ipadm show-addr output
   * @param {string} output - Command output
   * @returns {Array} Parsed IP address data
   */
  parseIPAddrOutput(output) {
    return this.parsingController.parseIPAddrOutput(output);
  }

  /**
   * Parse netstat -rn output
   * @param {string} output - Command output
   * @returns {Array} Parsed routing table data
   */
  parseRoutingOutput(output) {
    return this.parsingController.parseRoutingOutput(output);
  }

  /**
   * Parse dladm show-aggr output
   * @param {string} output - Command output
   * @returns {Array} Parsed aggregate data
   */
  parseAggregateOutput(output) {
    return this.parsingController.parseAggregateOutput(output);
  }

  /**
   * Check if a line appears to be a header line
   * @param {string} line - Line to check
   * @returns {boolean} True if line appears to be a header
   */
  isHeaderLine(line) {
    return this.parsingController.isHeaderLine(line);
  }

  /**
   * Check if a field contains valid numeric data
   * @param {string} field - Field to validate
   * @returns {boolean} True if field is valid numeric
   */
  isValidNumericField(field) {
    return this.parsingController.isValidNumericField(field);
  }

  /**
   * Check if a string contains header keywords
   * @param {string} str - String to check
   * @returns {boolean} True if string contains header keywords
   */
  isHeaderKeyword(str) {
    return this.parsingController.isHeaderKeyword(str);
  }

  /**
   * Collect IP address information
   * @description Gathers IP address assignments from ipadm show-addr
   */
  collectIPAddresses() {
    return this.dataController.collectIPAddresses();
  }

  /**
   * Collect routing table information
   * @description Gathers routing table from netstat -rn
   */
  collectRoutingTable() {
    return this.dataController.collectRoutingTable();
  }

  /**
   * Collect aggregate configuration
   * @description Gathers aggregate configuration from dladm show-aggr
   */
  collectAggregateConfig() {
    return this.configController.collectAggregateConfig();
  }

  /**
   * Collect network interface configuration
   * @description Gathers interface configuration from various dladm commands
   */
  async collectNetworkConfig() {
    // Update legacy property for compatibility
    if (this.configController.isCollecting) {
      return undefined;
    }
    this.isCollecting = this.configController.isCollecting;

    const result = await this.configController.collectNetworkConfig();

    // IP addresses + routing table ride the same config cycle. The pre-refactor
    // monolithic collector gathered these during its config pass; the modular
    // split left both methods built-but-never-invoked, so ip_addresses/routes
    // stayed permanently empty. Both handle their own errors (warn + []), so
    // they cannot fail the config result.
    await Promise.all([
      this.dataController.collectIPAddresses(),
      this.dataController.collectRoutingTable(),
    ]);

    this.isCollecting = this.configController.isCollecting;
    return result;
  }

  /**
   * Check if interface name appears to be truncated and find matches
   * @param {string} linkName - The interface name from usage output
   * @param {Array} allInterfaces - All known interfaces from configuration
   * @returns {Array} Array of possible full interface names
   */
  findPossibleFullInterfaceNames(linkName, allInterfaces) {
    return this.usageController.findPossibleFullInterfaceNames(linkName, allInterfaces);
  }

  /**
   * Correlate usage data with full interface names
   * @param {Array} usageData - Usage data with potentially truncated names
   * @param {Array} allInterfaces - All known interfaces from configuration
   * @returns {Array} Usage data with correlation information
   */
  correlateUsageWithInterfaces(usageData, allInterfaces) {
    return this.usageController.correlateUsageWithInterfaces(usageData, allInterfaces);
  }

  /**
   * Collect network usage data for a specific interface
   * @param {string} interfaceName - The full interface name
   * @param {string} acctFile - Path to accounting file
   * @param {number} timeout - Command timeout in milliseconds
   * @returns {Object|null} Usage data for the interface
   */
  collectSingleInterfaceUsage(interfaceName, acctFile, timeout) {
    return this.usageController.collectSingleInterfaceUsage(interfaceName, acctFile, timeout);
  }

  /**
   * Calculate bandwidth utilization percentage
   * @param {string} bytes - Bytes transferred
   * @param {number} speedMbps - Interface speed in Mbps
   * @param {number} timePeriod - Time period in seconds
   * @returns {number|null} Utilization percentage
   */
  calculateBandwidthUtilization(bytes, speedMbps, timePeriod) {
    return this.usageController.calculateBandwidthUtilization(bytes, speedMbps, timePeriod);
  }

  /**
   * Calculate instantaneous bandwidth from byte counters
   * @param {Object} currentStats - Current interface statistics
   * @param {Object} previousStats - Previous interface statistics
   * @returns {Object} Calculated bandwidth information
   */
  calculateInstantaneousBandwidth(currentStats, previousStats) {
    return this.usageController.calculateInstantaneousBandwidth(currentStats, previousStats);
  }

  /**
   * Collect network usage data using link statistics
   * @description Gathers usage data from dladm show-link -s and calculates bandwidth utilization
   */
  collectNetworkUsage() {
    return this.usageController.collectNetworkUsage();
  }

  /**
   * Clean up old data based on retention policies
   */
  cleanupOldData() {
    return this.cleanupController.cleanupOldData();
  }
}

export default NetworkCollector;
