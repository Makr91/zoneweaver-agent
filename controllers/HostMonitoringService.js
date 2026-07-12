/**
 * @fileoverview Host Monitoring Service for Zoneweaver Agent
 * @description Coordinates network and storage data collection with configurable intervals
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import config from '../config/ConfigLoader.js';
import NetworkCollector from './NetworkCollectorController/index.js';
import StorageCollector from './StorageController/index.js';
import DeviceCollector from './DeviceCollector.js';
import SystemMetricsCollector from './SystemMetricsCollector.js';
import ZvolIoCollector from './ZvolIoCollector.js';
import { cleanupOldTasks } from './TaskQueue/index.js';
import CleanupService from './CleanupService.js';
import HostInfo from '../models/HostInfoModel.js';
import DatabaseMigrations from '../config/DatabaseMigrations.js';
import { getRebootStatus, checkAndClearAfterReboot } from '../lib/RebootManager.js';
import { getFaultStatusForHealth } from './FaultManagementController/index.js';
import { log } from '../lib/Logger.js';
import os from 'os';

/**
 * Host Monitoring Service Class
 * @description Main service that orchestrates all host data collection activities
 */
class HostMonitoringService {
  constructor() {
    this.hostMonitoringConfig = config.getHostMonitoring();
    this.hostname = os.hostname();
    this.networkCollector = new NetworkCollector();
    this.storageCollector = new StorageCollector();
    this.deviceCollector = new DeviceCollector();
    this.systemMetricsCollector = new SystemMetricsCollector();
    // Per-zvol disk I/O rides a long-lived DTrace consumer rather than the
    // interval timers — it is stream-driven (see ZvolIoCollector).
    this.zvolIoCollector = new ZvolIoCollector();

    this.isRunning = false;
    this.isInitialized = false;

    // Performance tracking (updated by collectors, not by intervals)
    this.stats = {
      networkConfigRuns: 0,
      networkUsageRuns: 0,
      storageRuns: 0,
      deviceRuns: 0,
      systemMetricsRuns: 0,
      lastNetworkConfigSuccess: null,
      lastNetworkUsageSuccess: null,
      lastStorageSuccess: null,
      lastDeviceSuccess: null,
      lastSystemMetricsSuccess: null,
      totalErrors: 0,
    };
  }

  /**
   * Register cleanup tasks with CleanupService
   * @description Registers all collector cleanup functions with the centralized CleanupService
   */
  registerCleanupTasks() {
    try {
      // Register network data cleanup
      CleanupService.registerTask({
        name: 'network_cleanup',
        description: 'Clean up old network statistics and usage data',
        handler: async () => {
          await this.networkCollector.cleanupOldData();
        },
      });

      // Register storage data cleanup
      CleanupService.registerTask({
        name: 'storage_cleanup',
        description: 'Clean up old storage and ZFS data',
        handler: async () => {
          await this.storageCollector.cleanupOldData();
        },
      });

      // Register device data cleanup
      CleanupService.registerTask({
        name: 'device_cleanup',
        description: 'Clean up old PCI device data',
        handler: async () => {
          await this.deviceCollector.cleanupOldData();
        },
      });

      // Register system metrics cleanup
      CleanupService.registerTask({
        name: 'system_metrics_cleanup',
        description: 'Clean up old CPU and memory statistics',
        handler: async () => {
          await this.systemMetricsCollector.cleanupOldData();
        },
      });

      // Register per-zvol disk I/O cleanup
      CleanupService.registerTask({
        name: 'zvol_io_cleanup',
        description: 'Clean up old per-machine, per-zvol disk I/O data',
        handler: async () => {
          await this.zvolIoCollector.cleanupOldData();
        },
      });

      // Register task cleanup
      CleanupService.registerTask({
        name: 'task_cleanup',
        description: 'Clean up old completed, failed, and cancelled tasks',
        handler: async () => {
          await cleanupOldTasks();
        },
      });

      log.monitoring.info('Cleanup tasks registration completed', {
        tasks_registered: 6,
        cleanup_service_started: true,
      });

      // Start CleanupService now that all tasks are registered
      CleanupService.start();
    } catch (error) {
      log.monitoring.error('Failed to register cleanup tasks', {
        error: error.message,
        stack: error.stack,
      });
    }
  }

  /**
   * Initialize the monitoring service
   * @description Sets up network accounting and performs initial data collection
   */
  async initialize() {
    if (this.isInitialized) {
      return true;
    }

    if (!this.hostMonitoringConfig.enabled) {
      return false;
    }

    try {
      // Initialize database schema (idempotent — also runs at startup in index.js)
      await DatabaseMigrations.setupDatabase();

      // Initialize host info record
      await HostInfo.upsert({
        host: this.hostname,
        hostname: this.hostname,
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        uptime: Math.floor(os.uptime()),
        network_acct_enabled: false,
        network_scan_errors: 0,
        storage_scan_errors: 0,
        last_error_message: null,
      });

      // Initialize network accounting
      const networkAcctEnabled = await this.networkCollector.initializeNetworkAccounting();
      if (!networkAcctEnabled) {
        log.monitoring.warn('Network accounting initialization failed or disabled', {
          hostname: this.hostname,
        });
      }

      // Perform initial data collection
      // Initial network config collection (async)
      this.networkCollector.collectNetworkConfig().catch(error => {
        log.monitoring.error('Initial network config collection failed', {
          error: error.message,
          hostname: this.hostname,
        });
      });

      // Initial storage collection (async)
      this.storageCollector.collectStorageData().catch(error => {
        log.monitoring.error('Initial storage collection failed', {
          error: error.message,
          hostname: this.hostname,
        });
      });

      // Initial system metrics collection (async)
      this.systemMetricsCollector.collectSystemMetrics().catch(error => {
        log.monitoring.error('Initial system metrics collection failed', {
          error: error.message,
          hostname: this.hostname,
        });
      });

      // Check and clear reboot flags if system has rebooted since flags were created
      try {
        const rebootCheckResult = await checkAndClearAfterReboot();
        if (rebootCheckResult.action === 'cleared') {
          log.monitoring.info('Reboot flags cleared on startup', {
            reasons_cleared: rebootCheckResult.reasons_cleared,
            hostname: this.hostname,
          });
        } else if (rebootCheckResult.action === 'kept') {
          log.monitoring.debug('Keeping reboot flags (system not rebooted)', {
            flag_age_minutes: rebootCheckResult.flag_age_minutes,
            hostname: this.hostname,
          });
        }
      } catch (error) {
        log.monitoring.warn('Failed to check reboot flags on startup', {
          error: error.message,
          hostname: this.hostname,
        });
      }

      // Register cleanup tasks with CleanupService
      this.registerCleanupTasks();

      this.isInitialized = true;
      return true;
    } catch (error) {
      log.monitoring.error('Failed to initialize host monitoring service', {
        error: error.message,
        stack: error.stack,
        hostname: this.hostname,
      });
      return false;
    }
  }

  /**
   * Start host monitoring service
   * @description Marks service as running - actual data collection is handled by TaskQueue
   */
  async start() {
    if (!this.isInitialized) {
      const initialized = await this.initialize();
      if (!initialized) {
        log.monitoring.error('Cannot start host monitoring - initialization failed', {
          hostname: this.hostname,
        });
        return false;
      }
    }

    if (this.isRunning) {
      return true;
    }

    try {
      this.isRunning = true;
      // Stream-driven collector: the DTrace consumer runs continuously and
      // emits its own intervals (per-zvol disk I/O has no pollable source).
      this.zvolIoCollector.start();
      log.monitoring.info('Host monitoring service started (TaskQueue-based discovery)', {
        hostname: this.hostname,
      });
      return true;
    } catch (error) {
      log.monitoring.error('Failed to start host monitoring service', {
        error: error.message,
        stack: error.stack,
        hostname: this.hostname,
      });
      return false;
    }
  }

  /**
   * Stop host monitoring service
   * @description Marks service as stopped - TaskQueue handles actual collection intervals
   */
  stop() {
    this.isRunning = false;
    this.zvolIoCollector.stop();
    log.monitoring.info('Host monitoring service stopped', {
      hostname: this.hostname,
    });
  }

  /**
   * Restart the monitoring service
   * @description Stops and starts the service (discovery continues via TaskQueue)
   */
  restart() {
    this.stop();
    return this.start();
  }

  /**
   * Get current service status
   * @returns {Object} Service status information
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      isInitialized: this.isInitialized,
      discoveryMode: 'direct',
      config: {
        enabled: this.hostMonitoringConfig.enabled,
        intervals: this.hostMonitoringConfig.intervals,
        retention: this.hostMonitoringConfig.retention,
      },
      stats: {
        ...this.stats,
        uptime: this.isRunning
          ? Math.floor((Date.now() - (this.stats.lastNetworkConfigSuccess || Date.now())) / 1000)
          : 0,
      },
      note: 'Collections run directly on their timers; progress via host_info last_*_scan timestamps',
    };
  }

  /**
   * Trigger immediate data collection
   * @param {string} type - Type of collection ('network', 'storage', 'devices', 'system', 'all')
   * @returns {Object} Collection results
   */
  async triggerCollection(type = 'all') {
    const results = {
      networkConfig: null,
      networkUsage: null,
      storage: null,
      devices: null,
      systemMetrics: null,
      errors: [],
    };

    try {
      if (type === 'network' || type === 'all') {
        try {
          results.networkConfig = await this.networkCollector.collectNetworkConfig();
          results.networkUsage = await this.networkCollector.collectNetworkUsage();
        } catch (error) {
          results.errors.push(`Network collection: ${error.message}`);
        }
      }

      if (type === 'storage' || type === 'all') {
        try {
          results.storage = await this.storageCollector.collectStorageData();
        } catch (error) {
          results.errors.push(`Storage collection: ${error.message}`);
        }
      }

      if (type === 'devices' || type === 'all') {
        try {
          results.devices = await this.deviceCollector.collectPCIDevices();
        } catch (error) {
          results.errors.push(`Device collection: ${error.message}`);
        }
      }

      if (type === 'system' || type === 'all') {
        try {
          results.systemMetrics = await this.systemMetricsCollector.collectSystemMetrics();
        } catch (error) {
          results.errors.push(`System metrics collection: ${error.message}`);
        }
      }

      return results;
    } catch (error) {
      log.monitoring.error('Immediate collection failed', {
        error: error.message,
        type,
        hostname: this.hostname,
      });
      results.errors.push(`General error: ${error.message}`);
      return results;
    }
  }

  /**
   * Update configuration and restart if needed
   * @param {Object} newConfig - New configuration settings
   */
  async updateConfig(newConfig) {
    try {
      // This would typically involve updating the config file
      // For now, we'll just restart with current config
      Object.assign(this.hostMonitoringConfig, newConfig);

      if (this.isRunning) {
        await this.restart();
      }

      return true;
    } catch (error) {
      log.monitoring.error('Failed to update configuration', {
        error: error.message,
        stack: error.stack,
        hostname: this.hostname,
      });
      return false;
    }
  }

  /**
   * Get health check information
   * @returns {Object} Health status
   */
  async getHealthCheck() {
    try {
      const hostInfo = await HostInfo.findOne({
        where: { host: this.hostname },
      });

      const now = new Date();
      const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

      // Get reboot status
      const rebootStatus = await getRebootStatus();

      // Get fault status
      const faultStatus = await getFaultStatusForHealth();

      // Calculate overall system health status
      let overallStatus = this.isRunning ? 'healthy' : 'stopped';

      if (faultStatus.hasFaults) {
        const hasCritical = faultStatus.severityLevels.includes('Critical');
        const hasMajor = faultStatus.severityLevels.includes('Major');

        if (hasCritical) {
          overallStatus = 'critical';
        } else if (hasMajor) {
          overallStatus = 'faulted';
        } else {
          overallStatus = 'degraded';
        }
      }

      return {
        status: overallStatus,
        lastUpdate: hostInfo ? hostInfo.updated_at : null,
        networkErrors: hostInfo ? hostInfo.network_scan_errors : 0,
        storageErrors: hostInfo ? hostInfo.storage_scan_errors : 0,
        faultStatus: {
          hasFaults: faultStatus.hasFaults,
          faultCount: faultStatus.faultCount,
          severityLevels: faultStatus.severityLevels,
          lastCheck: faultStatus.lastCheck,
          faults: faultStatus.faults || [],
          error: faultStatus.error || null,
        },
        recentActivity: {
          network: hostInfo && hostInfo.last_network_scan > fiveMinutesAgo,
          storage: hostInfo && hostInfo.last_storage_scan > fiveMinutesAgo,
        },
        uptime: Math.floor(os.uptime()),
        reboot_required: rebootStatus.reboot_required,
        reboot_info: rebootStatus.reboot_required
          ? {
              timestamp: rebootStatus.timestamp,
              reasons: rebootStatus.reasons,
              age_minutes: rebootStatus.age_minutes,
              created_by: rebootStatus.created_by,
            }
          : null,
        service: this.getStatus(),
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message,
        uptime: Math.floor(os.uptime()),
      };
    }
  }
}

// Create singleton instance
const hostMonitoringService = new HostMonitoringService();

/**
 * Start host monitoring service
 * @description Exported function to start the service
 */
export const startHostMonitoring = () => hostMonitoringService.start();

/**
 * Stop host monitoring service
 * @description Exported function to stop the service
 */
export const stopHostMonitoring = () => {
  hostMonitoringService.stop();
};

/**
 * Get service instance
 * @description Exported function to get the service instance
 */
export const getHostMonitoringService = () => hostMonitoringService;

export default hostMonitoringService;
