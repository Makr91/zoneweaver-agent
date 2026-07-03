/**
 * @fileoverview Host Monitoring Controller Index
 * @description Main entry point for host monitoring controllers
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

// Import service management functions
import { getMonitoringStatus, getHealthCheck, triggerCollection } from './ServiceController.js';

// Import network monitoring functions
import {
  getNetworkInterfaces,
  getNetworkUsage,
  getIPAddresses,
  getRoutes,
} from './NetworkMonitoringController.js';

// Import storage monitoring functions
import {
  getZFSPools,
  getZFSDatasets,
  getDisks,
  getDiskIOStats,
  getPoolIOStats,
  getARCStats,
} from './StorageMonitoringController.js';

// Import system metrics functions
import { getCPUStats, getMemoryStats, getSystemLoadMetrics } from './SystemMetricsController.js';

// Import summary functions
import { getHostInfo, getMonitoringSummary } from './SummaryController.js';

// Export all functions with their original names for backward compatibility
export {
  // Service management
  getMonitoringStatus,
  getHealthCheck,
  triggerCollection,

  // Network monitoring
  getNetworkInterfaces,
  getNetworkUsage,
  getIPAddresses,
  getRoutes,

  // Storage monitoring
  getZFSPools,
  getZFSDatasets,
  getDisks,
  getDiskIOStats,
  getPoolIOStats,
  getARCStats,

  // System metrics
  getCPUStats,
  getMemoryStats,
  getSystemLoadMetrics,

  // Summary and host info
  getHostInfo,
  getMonitoringSummary,
};

// Default export for compatibility
export default {
  // Service management
  getMonitoringStatus,
  getHealthCheck,
  triggerCollection,

  // Network monitoring
  getNetworkInterfaces,
  getNetworkUsage,
  getIPAddresses,
  getRoutes,

  // Storage monitoring
  getZFSPools,
  getZFSDatasets,
  getDisks,
  getDiskIOStats,
  getPoolIOStats,
  getARCStats,

  // System metrics
  getCPUStats,
  getMemoryStats,
  getSystemLoadMetrics,

  // Summary and host info
  getHostInfo,
  getMonitoringSummary,
};
