import { verifyApiKey } from '../middleware/VerifyApiKey.js';
import {
  getMonitoringStatus,
  getHealthCheck,
  triggerCollection,
  getNetworkInterfaces,
  getNetworkUsage,
  getIPAddresses,
  getRoutes,
  getZFSPools,
  getZFSDatasets,
  getDisks,
  getDiskIOStats,
  getPoolIOStats,
  getARCStats,
  getHostInfo,
  getMonitoringSummary,
  getCPUStats,
  getMemoryStats,
  getSystemLoadMetrics,
} from '../controllers/HostMonitoringController/index.js';
import {
  listSwapAreas,
  getSwapSummary,
  addSwapArea,
  removeSwapArea,
  getHostsWithLowSwap,
} from '../controllers/SwapController.js';
import {
  listDevices,
  listAvailableDevices,
  getDeviceDetails,
  getDeviceCategories,
  getPPTStatus,
  triggerDeviceDiscovery,
} from '../controllers/HostDevicesController.js';

/**
 * @fileoverview Monitoring routes — host telemetry (/monitoring/*), swap
 * management, and PCI device discovery.
 */

/**
 * Register the monitoring, swap, and device route set on the shared router.
 * @param {import('express').Router} router - Application router
 */
export const registerMonitoringRoutes = router => {
  // Host Monitoring Routes
  router.get('/monitoring/status', verifyApiKey, getMonitoringStatus); // Get monitoring service status
  router.get('/monitoring/health', verifyApiKey, getHealthCheck); // Get monitoring health check
  router.get('/monitoring/summary', verifyApiKey, getMonitoringSummary); // Get monitoring summary
  router.post('/monitoring/collect', verifyApiKey, triggerCollection); // Trigger immediate data collection
  router.get('/monitoring/host', verifyApiKey, getHostInfo); // Get host information

  // Network Monitoring Routes
  router.get('/monitoring/network/interfaces', verifyApiKey, getNetworkInterfaces); // Get network interface data
  router.get('/monitoring/network/usage', verifyApiKey, getNetworkUsage); // Get network usage accounting data
  router.get('/monitoring/network/ipaddresses', verifyApiKey, getIPAddresses); // Get IP address assignments
  router.get('/monitoring/network/routes', verifyApiKey, getRoutes); // Get routing table information

  // Storage Monitoring Routes
  router.get('/monitoring/storage/pools', verifyApiKey, getZFSPools); // Get ZFS pool information
  router.get('/monitoring/storage/datasets', verifyApiKey, getZFSDatasets); // Get ZFS dataset information
  router.get('/monitoring/storage/disks', verifyApiKey, getDisks); // Get physical disk information
  router.get('/monitoring/storage/disk-io', verifyApiKey, getDiskIOStats); // Get disk I/O statistics
  router.get('/monitoring/storage/pool-io', verifyApiKey, getPoolIOStats); // Get pool I/O performance statistics
  router.get('/monitoring/storage/arc', verifyApiKey, getARCStats); // Get ZFS ARC statistics

  // System Metrics Monitoring Routes
  router.get('/monitoring/system/cpu', verifyApiKey, getCPUStats); // Get CPU performance statistics
  router.get('/monitoring/system/memory', verifyApiKey, getMemoryStats); // Get memory usage statistics
  router.get('/monitoring/system/load', verifyApiKey, getSystemLoadMetrics); // Get system load and activity metrics

  // Swap Management Routes
  router.get('/system/swap/areas', verifyApiKey, listSwapAreas); // Get detailed swap area information
  router.get('/system/swap/summary', verifyApiKey, getSwapSummary); // Get swap configuration summary
  router.get('/monitoring/hosts/low-swap', verifyApiKey, getHostsWithLowSwap); // Get hosts with high swap utilization
  router.post('/system/swap/add', verifyApiKey, addSwapArea); // Add a new swap area
  router.delete('/system/swap/remove', verifyApiKey, removeSwapArea); // Remove a swap area

  // Host Device Monitoring Routes
  router.get('/host/devices', verifyApiKey, listDevices); // List all PCI devices
  router.get('/host/devices/available', verifyApiKey, listAvailableDevices); // List available devices for passthrough
  router.get('/host/devices/categories', verifyApiKey, getDeviceCategories); // Get device categories summary
  router.get('/host/devices/:deviceId', verifyApiKey, getDeviceDetails); // Get specific device details
  router.get('/host/ppt-status', verifyApiKey, getPPTStatus); // Get PPT status and assignments
  router.post('/host/devices/refresh', verifyApiKey, triggerDeviceDiscovery); // Trigger device discovery
};
