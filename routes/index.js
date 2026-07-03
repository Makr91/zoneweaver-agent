import express from 'express';
import { serverStats } from '../controllers/ServerStats.js';
import { verifyApiKey } from '../middleware/VerifyApiKey.js';
import {
  bootstrapFirstApiKey,
  generateApiKey,
  listApiKeys,
  deleteApiKey,
  revokeApiKey,
  getApiKeyInfo,
} from '../controllers/ApiKeys.js';
import {
  listZones,
  getZoneDetails,
  getZoneConfig,
  getZoneNotes,
  updateZoneNotes,
  getZoneTags,
  updateZoneTags,
  startZone,
  stopZone,
  restartZone,
  deleteZone,
  createZone,
  modifyZone,
  bulkStartZones,
  bulkStopZones,
  cloneZone,
} from '../controllers/ZoneManagement/index.js';
import { getServerIds, getNextServerId } from '../controllers/ZoneServerIds.js';
import {
  listTasks,
  getTaskDetails,
  getTaskOutput,
  cancelTask,
  getTaskStats,
  clearCompletedTasks,
} from '../controllers/TaskQueue/index.js';
import {
  startVncSession,
  getVncSessionInfo,
  stopVncSession,
  listVncSessions,
  getVncScreenshot,
} from '../controllers/VncConsoleController/index.js';
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
  listDevices,
  listAvailableDevices,
  getDeviceDetails,
  getDeviceCategories,
  getPPTStatus,
  triggerDeviceDiscovery,
} from '../controllers/HostDevicesController.js';
import {
  getSettings,
  getSettingsSchema,
  updateSettings,
  createConfigBackup,
  listBackups,
  restoreBackup,
  deleteBackup,
  restartServer,
} from '../controllers/SettingsController/index.js';
import {
  listSwapAreas,
  getSwapSummary,
  addSwapArea,
  removeSwapArea,
  getHostsWithLowSwap,
} from '../controllers/SwapController.js';
import { getRoot } from '../controllers/RootController.js';
import { getProvisioningStatus } from '../controllers/ProvisioningController.js';
import {
  getProvisioningNetworkStatus,
  setupProvisioningNetwork,
  teardownProvisioningNetwork,
} from '../controllers/ProvisioningNetworkController.js';
import {
  listRecipes,
  createRecipe,
  getRecipe,
  updateRecipe,
  deleteRecipe,
  testRecipe,
} from '../controllers/RecipeController.js';
import {
  provisionZone,
  getProvisioningStatus as getZoneProvisioningStatus,
  listProvisioningProfiles,
  createProvisioningProfile,
  getProvisioningProfile,
  updateProvisioningProfile,
  deleteProvisioningProfile,
  syncZone,
  runProvisioners,
} from '../controllers/ProvisioningOrchestrationController/index.js';
import {
  startTerminalSession,
  stopTerminalSession,
  getTerminalSessionInfo,
  listTerminalSessions,
  checkSessionHealth,
} from '../controllers/TerminalSessionController.js';
import {
  startZloginSession,
  stopZloginSession,
  getZloginSessionInfo,
  listZloginSessions,
} from '../controllers/ZloginController.js';
import {
  startSSHSession,
  stopSSHSession,
  getSSHSessionInfo,
  listSSHSessions,
} from '../controllers/SSHTerminalController.js';
import {
  listServices,
  getServiceDetailsController,
  serviceAction,
  getPropertiesController,
} from '../controllers/ServicesController.js';
import {
  getHostname,
  setHostname,
  getIPAddresses as getManageableIPAddresses,
  createIPAddress,
  deleteIPAddress,
  enableIPAddress,
  disableIPAddress,
} from '../controllers/NetworkController/index.js';
import {
  getVNICs,
  getVNICDetails,
  createVNIC,
  deleteVNIC,
  getVNICStats,
  getVNICProperties,
  setVNICProperties,
} from '../controllers/VnicController/index.js';
import {
  getAggregates,
  getAggregateDetails,
  createAggregate,
  deleteAggregate,
  modifyAggregateLinks,
  getAggregateStats,
} from '../controllers/AggregateController.js';
import {
  getEtherstubs,
  getEtherstubDetails,
  createEtherstub,
  deleteEtherstub,
} from '../controllers/EtherstubController.js';
import { getVlans, getVlanDetails, createVlan, deleteVlan } from '../controllers/VlanController.js';
import {
  getBridges,
  getBridgeDetails,
  createBridge,
  deleteBridge,
  modifyBridgeLinks,
} from '../controllers/BridgeController/index.js';
import {
  getNatRules,
  createNatRule,
  deleteNatRule,
  getNatStatus,
  getForwardingStatus,
  configureForwarding,
} from '../controllers/NatController.js';
import {
  getDhcpConfig,
  updateDhcpConfig,
  getDhcpHosts,
  addDhcpHost,
  removeDhcpHost,
  getDhcpStatus,
  controlDhcpService,
} from '../controllers/DhcpController.js';
import {
  listPackages,
  searchPackages,
  getPackageInfo,
  installPackages,
  uninstallPackages,
} from '../controllers/PackageController.js';
import {
  checkForUpdates,
  installUpdates,
  getUpdateHistory,
  refreshMetadata,
} from '../controllers/SystemUpdateController.js';
import {
  listBootEnvironments,
  createBootEnvironment,
  deleteBootEnvironment,
  activateBootEnvironment,
  mountBootEnvironment,
  unmountBootEnvironment,
} from '../controllers/BootEnvironmentController/index.js';
import {
  listRepositories,
  addRepository,
  removeRepository,
  modifyRepository,
  enableRepository,
  disableRepository,
} from '../controllers/RepositoryController/index.js';
import {
  getTimeSyncStatus,
  getTimeSyncConfig,
  updateTimeSyncConfig,
  forceTimeSync,
  getTimezone,
  setTimezone,
  listTimezones,
  getAvailableTimeSyncSystems,
  switchTimeSyncSystem,
} from '../controllers/TimeSyncController/index.js';
import {
  getARCConfig,
  updateARCConfig,
  validateARCConfig,
  resetARCConfig,
} from '../controllers/ARCConfigController/index.js';
import {
  listDatasets,
  getDatasetDetails,
  createDataset,
  destroyDataset,
  setDatasetProperties,
  cloneDataset,
  promoteDataset,
  renameDataset,
  createSnapshot,
  destroySnapshot,
  rollbackSnapshot,
  holdSnapshot,
  releaseSnapshot,
  listHolds,
} from '../controllers/ZFSDatasetController/index.js';
import {
  listPools,
  getPoolDetails,
  getPoolStatus,
  createPool,
  destroyPool,
  setPoolProperties,
  addVdev,
  removeVdev,
  replaceDevice,
  onlineDevice,
  offlineDevice,
  scrubPool,
  stopScrub,
  exportPool,
  importPool,
  listImportablePools,
  upgradePool,
} from '../controllers/ZPoolController/index.js';
import {
  listSources,
  listRemoteTemplates,
  getRemoteTemplateDetails,
  listLocalTemplates,
  getLocalTemplate,
  downloadTemplate,
  deleteLocalTemplate,
  publishTemplate,
  exportTemplate,
  moveTemplate,
} from '../controllers/TemplateController.js';
import {
  getFaults,
  getFaultDetails,
  getFaultManagerConfig,
  acquitFault,
  markRepaired,
  markReplaced,
} from '../controllers/FaultManagementController/index.js';
import {
  listLogFiles,
  getLogFile,
  getFaultManagerLogs,
} from '../controllers/SystemLogsController.js';
import {
  startLogStream,
  listLogStreamSessions,
  stopLogStream,
  getLogStreamInfo,
} from '../controllers/LogStreamController.js';
import {
  getSyslogConfig,
  updateSyslogConfig,
  getSyslogFacilities,
  validateSyslogConfig,
  reloadSyslogService,
  switchSyslogService,
} from '../controllers/SyslogController.js';
import {
  listProcesses,
  getProcessDetailsController,
  sendSignalToProcess,
  killProcessController,
  getProcessFilesController,
  getProcessStackController,
  getProcessLimitsController,
  findProcessesController,
  batchKillProcesses,
  getProcessStatsController,
  startProcessTrace,
} from '../controllers/ProcessController.js';
import {
  browseDirectory,
  createFolder,
  uploadFile,
  downloadFile,
  readFile,
  writeFile,
  moveFileItem,
  copyFileItem,
  renameItem,
  deleteFileItem,
  createArchiveTask,
  extractArchiveTask,
  changePermissions,
} from '../controllers/FileSystemController/index.js';
import {
  getCurrentUserInfo,
  getSystemUsers,
  getSystemGroups,
  lookupUser,
  lookupGroup,
  createSystemUser,
  deleteSystemUser,
  modifySystemUser,
  createSystemGroup,
  deleteSystemGroup,
  modifySystemGroup,
  setUserPassword,
  lockUserAccount,
  unlockUserAccount,
  getSystemRoles,
  createSystemRole,
  deleteSystemRole,
  modifySystemRole,
  getAvailableAuthorizations,
  getAvailableProfiles,
  getAvailableRoles,
  getUserAttributes,
} from '../controllers/SystemAccountController/index.js';
import {
  uploadSingle,
  validateUploadRequest,
  handleUploadError,
} from '../middleware/FileUpload.js';
import {
  listStoragePaths,
  createStoragePath,
  updateStoragePath,
  deleteStoragePath,
  listArtifacts,
  listISOArtifacts,
  listImageArtifacts,
  getArtifactDetails,
  downloadFromUrl,
  prepareArtifactUpload,
  uploadArtifactToTask,
  downloadArtifact,
  scanArtifacts,
  deleteArtifacts,
  getArtifactStats,
  getArtifactServiceStatus,
  moveArtifact,
  copyArtifact,
} from '../controllers/ArtifactController/index.js';
import {
  getSystemStatus,
  getSystemUptime,
  getRebootRequiredStatus,
  clearRebootRequiredStatus,
  restartHost,
  rebootHost,
  fastRebootHost,
  shutdownHost,
  poweroffHost,
  haltHost,
  getCurrentRunlevel,
  changeRunlevel,
  enterSingleUserMode,
  enterMultiUserMode,
} from '../controllers/SystemHostController/index.js';
import {
  getZoneOrchestrationStatus,
  enableOrchestration,
  disableOrchestration,
  getZonePriorities,
  testOrchestration,
} from '../controllers/ZoneOrchestrationController.js';
import { getHosts, updateHosts, getDns, updateDns } from '../controllers/HostConfigController.js';
import {
  getDatabaseStats,
  vacuumDatabase,
  analyzeDatabase,
  triggerCleanup,
} from '../controllers/DatabaseController.js';
import { getVersion, checkForAppUpdates } from '../controllers/VersionController.js';
import { getStatus } from '../controllers/StatusController.js';
import { getWsTicket } from '../controllers/WsTicketController.js';
import config from '../config/ConfigLoader.js';
import path from 'path';

const router = express.Router();

// Provisioning Routes
router.get('/provisioning/status', verifyApiKey, getProvisioningStatus);
router.get('/provisioning/network/status', verifyApiKey, getProvisioningNetworkStatus); // Check provisioning network status
router.post('/provisioning/network/setup', verifyApiKey, setupProvisioningNetwork); // Setup provisioning network
router.delete('/provisioning/network/teardown', verifyApiKey, teardownProvisioningNetwork); // Teardown provisioning network

// Provisioning Recipe Routes
router.get('/provisioning/recipes', verifyApiKey, listRecipes); // List all recipes
router.post('/provisioning/recipes', verifyApiKey, createRecipe); // Create recipe
router.get('/provisioning/recipes/:id', verifyApiKey, getRecipe); // Get recipe details
router.put('/provisioning/recipes/:id', verifyApiKey, updateRecipe); // Update recipe
router.delete('/provisioning/recipes/:id', verifyApiKey, deleteRecipe); // Delete recipe
router.post('/provisioning/recipes/:id/test', verifyApiKey, testRecipe); // Test recipe against zone

// Provisioning Profile Routes
router.get('/provisioning/profiles', verifyApiKey, listProvisioningProfiles); // List all profiles
router.post('/provisioning/profiles', verifyApiKey, createProvisioningProfile); // Create profile
router.get('/provisioning/profiles/:id', verifyApiKey, getProvisioningProfile); // Get profile details
router.put('/provisioning/profiles/:id', verifyApiKey, updateProvisioningProfile); // Update profile
router.delete('/provisioning/profiles/:id', verifyApiKey, deleteProvisioningProfile); // Delete profile

// Version and Update Routes
router.get('/version', verifyApiKey, getVersion); // Get application version information
router.get('/app/updates/check', verifyApiKey, checkForAppUpdates); // Check for application updates

// Get configuration for conditional routing
const statsConfig = config.get('stats') || { public_access: false };
const uiConfig = config.get('ui') || {};

// UI shim (Direct mode): serve the published Hyperweaver UI artifact when enabled
if (uiConfig.enabled) {
  const uiDir = path.resolve(uiConfig.path || path.join(process.cwd(), 'ui'));

  router.use('/ui', express.static(uiDir));
  router.get('/ui/*splat', (req, res) => {
    // SPA fallback: client-side routes resolve to index.html
    void req;
    res.sendFile(path.join(uiDir, 'index.html'), err => {
      if (err && !res.headersSent) {
        res.status(503).json({
          error: 'UI artifact not installed',
          details:
            'The Hyperweaver UI is baked in at package build time - reinstall the package or check ui.path',
        });
      }
    });
  });
  router.get('/', (req, res) => {
    void req;
    res.redirect('/ui/');
  });
} else {
  // Root route to display registered Zoneweaver Agent instances
  router.get('/', getRoot);
}

// Public routes (no authentication required)
router.get('/status', getStatus); // Public slim identity & capabilities (Hyperweaver dual-mode contract)
router.get('/api/status', getStatus); // Unconditional alias — the single mode-discovery probe URL for the SPA
router.post('/api-keys/bootstrap', bootstrapFirstApiKey); // Bootstrap endpoint for initial setup

// Conditionally public stats endpoint
if (statsConfig.public_access) {
  router.get('/stats', serverStats); // Public access to server stats
} else {
  router.get('/stats', verifyApiKey, serverStats); // Protected access to server stats
}

// API Key protected routes (require valid API key)
router.post('/api-keys/generate', verifyApiKey, generateApiKey); // Generate new API key
router.get('/api-keys', verifyApiKey, listApiKeys); // List all API keys
router.get('/api-keys/info', verifyApiKey, getApiKeyInfo); // Get current API key info
router.delete('/api-keys/:id', verifyApiKey, deleteApiKey); // Delete an API key
router.put('/api-keys/:id/revoke', verifyApiKey, revokeApiKey); // Revoke an API key

// WebSocket Ticket Route (every WS upgrade requires ?ticket= minted here)
router.get('/ws-ticket', verifyApiKey, getWsTicket);

// Zone Orchestration Management Routes (MUST come before parameterized routes)
router.get('/zones/orchestration/status', verifyApiKey, getZoneOrchestrationStatus); // Get orchestration control status
router.post('/zones/orchestration/enable', verifyApiKey, enableOrchestration); // Enable zone orchestration control
router.post('/zones/orchestration/disable', verifyApiKey, disableOrchestration); // Disable zone orchestration control
router.get('/zones/priorities', verifyApiKey, getZonePriorities); // List all zones with priorities
router.post('/zones/orchestration/test', verifyApiKey, testOrchestration); // Test orchestration (dry run)

// Bulk Zone Operations (MUST come before parameterized routes)
router.post('/zones/bulk/start', verifyApiKey, bulkStartZones); // Bulk start zones
router.post('/zones/bulk/stop', verifyApiKey, bulkStopZones); // Bulk stop zones

// Zone Server ID Discovery Routes (must come before parameterized routes)
router.get('/zones/ids/next', verifyApiKey, getNextServerId); // Get next available server ID
router.get('/zones/ids', verifyApiKey, getServerIds); // Get server ID usage information

// Zone Creation & Modification Routes (must come before parameterized routes)
router.post('/zones', verifyApiKey, createZone); // Create a new zone
router.put('/zones/:zoneName', verifyApiKey, modifyZone); // Modify zone configuration

// Zone Management Routes (parameterized routes come after specific routes)
router.get('/zones', verifyApiKey, listZones); // List all zones
router.get('/zones/:zoneName', verifyApiKey, getZoneDetails); // Get zone details
router.get('/zones/:zoneName/config', verifyApiKey, getZoneConfig); // Get zone configuration
router.get('/zones/:zoneName/notes', verifyApiKey, getZoneNotes); // Get zone notes
router.put('/zones/:zoneName/notes', verifyApiKey, updateZoneNotes); // Update zone notes
router.get('/zones/:zoneName/tags', verifyApiKey, getZoneTags); // Get zone tags
router.put('/zones/:zoneName/tags', verifyApiKey, updateZoneTags); // Update zone tags
router.post('/zones/:zoneName/start', verifyApiKey, startZone); // Start zone
router.post('/zones/:zoneName/stop', verifyApiKey, stopZone); // Stop zone
router.post('/zones/:zoneName/restart', verifyApiKey, restartZone); // Restart zone
router.delete('/zones/:zoneName', verifyApiKey, deleteZone); // Delete zone
router.post('/zones/:zoneName/clone', verifyApiKey, cloneZone); // Clone zone

// Zone Provisioning Routes
router.post('/zones/:name/provision', verifyApiKey, provisionZone); // Start provisioning pipeline
router.get('/zones/:name/provision/status', verifyApiKey, getZoneProvisioningStatus); // Get provisioning status
router.post('/zones/:name/sync', verifyApiKey, syncZone); // Sync provisioning files ad-hoc
router.post('/zones/:name/run-provisioners', verifyApiKey, runProvisioners); // Run provisioners ad-hoc

// Task Management Routes
router.get('/tasks', verifyApiKey, listTasks); // List tasks (supports ?sort=&order= params)
router.get('/tasks/stats', verifyApiKey, getTaskStats); // Get task statistics
router.delete('/tasks/completed', verifyApiKey, clearCompletedTasks); // Hard-delete all completed/failed/cancelled tasks
router.get('/tasks/:taskId', verifyApiKey, getTaskDetails); // Get task details
router.get('/tasks/:taskId/output', verifyApiKey, getTaskOutput); // Get task output
router.delete('/tasks/:taskId', verifyApiKey, cancelTask); // Cancel task

// VNC Console Management Routes
router.post('/zones/:zoneName/vnc/start', verifyApiKey, startVncSession); // Start VNC session
router.get('/zones/:zoneName/vnc/info', verifyApiKey, getVncSessionInfo); // Get VNC session info
router.delete('/zones/:zoneName/vnc/stop', verifyApiKey, stopVncSession); // Stop VNC session
router.get('/zones/:zoneName/vnc/screenshot', verifyApiKey, getVncScreenshot); // Capture VNC console screenshot (PNG)
router.get('/vnc/sessions', verifyApiKey, listVncSessions); // List all VNC sessions

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

// Settings Management Routes
router.get('/settings', verifyApiKey, getSettings); // Get current application settings
router.get('/settings/schema', verifyApiKey, getSettingsSchema); // Get settings schema with types/defaults/descriptions
router.put('/settings', verifyApiKey, updateSettings); // Update application settings
router.post('/settings/backup', verifyApiKey, createConfigBackup); // Create a configuration backup
router.get('/settings/backups', verifyApiKey, listBackups); // List configuration backups
router.delete('/settings/backups/:filename', verifyApiKey, deleteBackup); // Delete a specific backup
router.post('/settings/restore/:filename', verifyApiKey, restoreBackup); // Restore configuration from backup
router.post('/server/restart', verifyApiKey, restartServer); // Restart the server (dummy endpoint)

// Terminal Routes
router.post('/terminal/start', verifyApiKey, startTerminalSession);
router.get('/terminal/sessions', verifyApiKey, listTerminalSessions);
router.get('/terminal/sessions/:terminal_cookie/health', verifyApiKey, checkSessionHealth);
router.get('/terminal/sessions/:sessionId', verifyApiKey, getTerminalSessionInfo);
router.delete('/terminal/sessions/:sessionId/stop', verifyApiKey, stopTerminalSession);

// Zlogin Routes
router.post('/zones/:zoneName/zlogin/start', verifyApiKey, startZloginSession);
router.get('/zlogin/sessions', verifyApiKey, listZloginSessions);
router.get('/zlogin/sessions/:sessionId', verifyApiKey, getZloginSessionInfo);
router.delete('/zlogin/sessions/:sessionId/stop', verifyApiKey, stopZloginSession);

// SSH Terminal Routes
router.post('/zones/:zoneName/ssh/start', verifyApiKey, startSSHSession);
router.get('/ssh/sessions', verifyApiKey, listSSHSessions);
router.get('/ssh/sessions/:sessionId', verifyApiKey, getSSHSessionInfo);
router.delete('/ssh/sessions/:sessionId/stop', verifyApiKey, stopSSHSession);

// Service Management Routes (ordered from most specific to least specific)
router.get('/services', verifyApiKey, listServices);
router.post('/services/action', verifyApiKey, serviceAction);
router.get('/services/:fmri/properties', verifyApiKey, getPropertiesController);
router.get('/services/:fmri', verifyApiKey, getServiceDetailsController);

// Network Management Routes - Hostname
router.get('/network/hostname', verifyApiKey, getHostname); // Get current hostname
router.put('/network/hostname', verifyApiKey, setHostname); // Set hostname

// Network Management Routes - IP Addresses
router.get('/network/addresses', verifyApiKey, getManageableIPAddresses); // List IP addresses
router.post('/network/addresses', verifyApiKey, createIPAddress); // Create IP address
router.delete('/network/addresses/*splat', verifyApiKey, deleteIPAddress); // Delete IP address (captures full addrobj with slashes)
router.put('/network/addresses/*splat/enable', verifyApiKey, enableIPAddress); // Enable IP address
router.put('/network/addresses/*splat/disable', verifyApiKey, disableIPAddress); // Disable IP address

// VNIC Management Routes
router.get('/network/vnics', verifyApiKey, getVNICs); // List VNICs
router.get('/network/vnics/:vnic', verifyApiKey, getVNICDetails); // Get VNIC details
router.post('/network/vnics', verifyApiKey, createVNIC); // Create VNIC
router.delete('/network/vnics/:vnic', verifyApiKey, deleteVNIC); // Delete VNIC
router.get('/network/vnics/:vnic/stats', verifyApiKey, getVNICStats); // Get VNIC statistics
router.get('/network/vnics/:vnic/properties', verifyApiKey, getVNICProperties); // Get VNIC properties
router.put('/network/vnics/:vnic/properties', verifyApiKey, setVNICProperties); // Set VNIC properties

// Link Aggregation Management Routes
router.get('/network/aggregates', verifyApiKey, getAggregates); // List aggregates
router.get('/network/aggregates/:aggregate', verifyApiKey, getAggregateDetails); // Get aggregate details
router.post('/network/aggregates', verifyApiKey, createAggregate); // Create aggregate
router.delete('/network/aggregates/:aggregate', verifyApiKey, deleteAggregate); // Delete aggregate
router.put('/network/aggregates/:aggregate/links', verifyApiKey, modifyAggregateLinks); // Modify aggregate links
router.get('/network/aggregates/:aggregate/stats', verifyApiKey, getAggregateStats); // Get aggregate statistics

// Etherstub Management Routes
router.get('/network/etherstubs', verifyApiKey, getEtherstubs); // List etherstubs
router.get('/network/etherstubs/:etherstub', verifyApiKey, getEtherstubDetails); // Get etherstub details
router.post('/network/etherstubs', verifyApiKey, createEtherstub); // Create etherstub
router.delete('/network/etherstubs/:etherstub', verifyApiKey, deleteEtherstub); // Delete etherstub

// VLAN Management Routes
router.get('/network/vlans', verifyApiKey, getVlans); // List VLANs
router.get('/network/vlans/:vlan', verifyApiKey, getVlanDetails); // Get VLAN details
router.post('/network/vlans', verifyApiKey, createVlan); // Create VLAN
router.delete('/network/vlans/:vlan', verifyApiKey, deleteVlan); // Delete VLAN

// Bridge Management Routes
router.get('/network/bridges', verifyApiKey, getBridges); // List bridges
router.get('/network/bridges/:bridge', verifyApiKey, getBridgeDetails); // Get bridge details
router.post('/network/bridges', verifyApiKey, createBridge); // Create bridge
router.delete('/network/bridges/:bridge', verifyApiKey, deleteBridge); // Delete bridge
router.put('/network/bridges/:bridge/links', verifyApiKey, modifyBridgeLinks); // Modify bridge links

// NAT and IP Forwarding Routes
router.get('/network/nat/rules', verifyApiKey, getNatRules); // List NAT rules
router.post('/network/nat/rules', verifyApiKey, createNatRule); // Create NAT rule
router.delete('/network/nat/rules/:ruleId', verifyApiKey, deleteNatRule); // Delete NAT rule
router.get('/network/nat/status', verifyApiKey, getNatStatus); // Get ipfilter service status
router.get('/network/forwarding', verifyApiKey, getForwardingStatus); // Get IP forwarding status
router.put('/network/forwarding', verifyApiKey, configureForwarding); // Configure IP forwarding

// DHCP Server Management Routes
router.get('/network/dhcp/config', verifyApiKey, getDhcpConfig); // Get DHCP configuration
router.put('/network/dhcp/config', verifyApiKey, updateDhcpConfig); // Update DHCP configuration
router.get('/network/dhcp/hosts', verifyApiKey, getDhcpHosts); // List DHCP static hosts
router.post('/network/dhcp/hosts', verifyApiKey, addDhcpHost); // Add DHCP host entry
router.delete('/network/dhcp/hosts/:hostname', verifyApiKey, removeDhcpHost); // Remove DHCP host entry
router.get('/network/dhcp/status', verifyApiKey, getDhcpStatus); // Get DHCP service status
router.put('/network/dhcp/status', verifyApiKey, controlDhcpService); // Control DHCP service

// Package Management Routes
router.get('/system/packages', verifyApiKey, listPackages); // List installed packages
router.get('/system/packages/search', verifyApiKey, searchPackages); // Search for packages
router.get('/system/packages/info', verifyApiKey, getPackageInfo); // Get package information
router.post('/system/packages/install', verifyApiKey, installPackages); // Install packages
router.post('/system/packages/uninstall', verifyApiKey, uninstallPackages); // Uninstall packages

// System Update Management Routes
router.get('/system/updates/check', verifyApiKey, checkForUpdates); // Check for system updates
router.post('/system/updates/install', verifyApiKey, installUpdates); // Install system updates
router.get('/system/updates/history', verifyApiKey, getUpdateHistory); // Get update history
router.post('/system/updates/refresh', verifyApiKey, refreshMetadata); // Refresh package metadata

// Boot Environment Management Routes
router.get('/system/boot-environments', verifyApiKey, listBootEnvironments); // List boot environments
router.post('/system/boot-environments', verifyApiKey, createBootEnvironment); // Create boot environment
router.delete('/system/boot-environments/:name', verifyApiKey, deleteBootEnvironment); // Delete boot environment
router.post('/system/boot-environments/:name/activate', verifyApiKey, activateBootEnvironment); // Activate boot environment
router.post('/system/boot-environments/:name/mount', verifyApiKey, mountBootEnvironment); // Mount boot environment
router.post('/system/boot-environments/:name/unmount', verifyApiKey, unmountBootEnvironment); // Unmount boot environment

// Repository Management Routes
router.get('/system/repositories', verifyApiKey, listRepositories); // List package repositories
router.post('/system/repositories', verifyApiKey, addRepository); // Add package repository
router.delete('/system/repositories/:name', verifyApiKey, removeRepository); // Remove package repository
router.put('/system/repositories/:name', verifyApiKey, modifyRepository); // Modify package repository
router.post('/system/repositories/:name/enable', verifyApiKey, enableRepository); // Enable package repository
router.post('/system/repositories/:name/disable', verifyApiKey, disableRepository); // Disable package repository

// Time Synchronization Routes
router.get('/system/time-sync/status', verifyApiKey, getTimeSyncStatus); // Get time sync service status
router.get('/system/time-sync/config', verifyApiKey, getTimeSyncConfig); // Get time sync configuration
router.put('/system/time-sync/config', verifyApiKey, updateTimeSyncConfig); // Update time sync configuration
router.post('/system/time-sync/sync', verifyApiKey, forceTimeSync); // Force immediate time synchronization
router.get('/system/time-sync/available-systems', verifyApiKey, getAvailableTimeSyncSystems); // Get available time sync systems
router.post('/system/time-sync/switch', verifyApiKey, switchTimeSyncSystem); // Switch between time sync systems

// Timezone Management Routes
router.get('/system/timezone', verifyApiKey, getTimezone); // Get current timezone
router.put('/system/timezone', verifyApiKey, setTimezone); // Set system timezone
router.get('/system/timezones', verifyApiKey, listTimezones); // List available timezones

// ZFS ARC Management Routes
router.get('/system/zfs/arc/config', verifyApiKey, getARCConfig); // Get ZFS ARC configuration and tunables
router.put('/system/zfs/arc/config', verifyApiKey, updateARCConfig); // Update ZFS ARC settings
router.post('/system/zfs/arc/validate', verifyApiKey, validateARCConfig); // Validate ZFS ARC configuration
router.post('/system/zfs/arc/reset', verifyApiKey, resetARCConfig); // Reset ZFS ARC to defaults

// ZFS Dataset Management Routes
router.get('/storage/datasets', verifyApiKey, listDatasets); // List ZFS datasets
router.get('/storage/datasets/:name', verifyApiKey, getDatasetDetails); // Get dataset details
router.post('/storage/datasets', verifyApiKey, createDataset); // Create dataset
router.delete('/storage/datasets/:name', verifyApiKey, destroyDataset); // Delete dataset
router.put('/storage/datasets/:name/properties', verifyApiKey, setDatasetProperties); // Set dataset properties
router.post('/storage/datasets/:name/clone', verifyApiKey, cloneDataset); // Clone dataset from snapshot
router.post('/storage/datasets/:name/promote', verifyApiKey, promoteDataset); // Promote clone to independent dataset
router.post('/storage/datasets/:name/rename', verifyApiKey, renameDataset); // Rename dataset

// ZFS Snapshot Management Routes
router.post('/storage/datasets/:name/snapshots', verifyApiKey, createSnapshot); // Create snapshot
router.delete('/storage/snapshots/:snapshot', verifyApiKey, destroySnapshot); // Delete snapshot
router.post('/storage/snapshots/:snapshot/rollback', verifyApiKey, rollbackSnapshot); // Rollback to snapshot
router.post('/storage/snapshots/:snapshot/holds', verifyApiKey, holdSnapshot); // Hold snapshot
router.delete('/storage/snapshots/:snapshot/holds/:tag', verifyApiKey, releaseSnapshot); // Release snapshot hold
router.get('/storage/snapshots/:snapshot/holds', verifyApiKey, listHolds); // List snapshot holds

// ZFS Pool Management Routes
router.get('/storage/pools', verifyApiKey, listPools); // List ZFS pools
router.get('/storage/pools/importable', verifyApiKey, listImportablePools); // List importable pools
router.post('/storage/pools/import', verifyApiKey, importPool); // Import pool
router.get('/storage/pools/:pool', verifyApiKey, getPoolDetails); // Get pool details
router.get('/storage/pools/:pool/status', verifyApiKey, getPoolStatus); // Get pool status
router.post('/storage/pools', verifyApiKey, createPool); // Create pool
router.delete('/storage/pools/:pool', verifyApiKey, destroyPool); // Destroy pool
router.put('/storage/pools/:pool/properties', verifyApiKey, setPoolProperties); // Set pool properties
router.post('/storage/pools/:pool/vdevs', verifyApiKey, addVdev); // Add vdev to pool
router.post('/storage/pools/:pool/vdevs/remove', verifyApiKey, removeVdev); // Remove vdev from pool
router.post('/storage/pools/:pool/devices/replace', verifyApiKey, replaceDevice); // Replace device in pool
router.post('/storage/pools/:pool/devices/online', verifyApiKey, onlineDevice); // Online device in pool
router.post('/storage/pools/:pool/devices/offline', verifyApiKey, offlineDevice); // Offline device in pool
router.post('/storage/pools/:pool/scrub', verifyApiKey, scrubPool); // Start pool scrub
router.post('/storage/pools/:pool/scrub/stop', verifyApiKey, stopScrub); // Stop pool scrub
router.post('/storage/pools/:pool/export', verifyApiKey, exportPool); // Export pool
router.post('/storage/pools/:pool/upgrade', verifyApiKey, upgradePool); // Upgrade pool

// Template Management Routes
router.get('/templates/sources', verifyApiKey, listSources);
router.get('/templates/remote/:sourceName', verifyApiKey, listRemoteTemplates);
router.get('/templates/remote/:sourceName/:org/:boxName', verifyApiKey, getRemoteTemplateDetails);
router.get('/templates/local', verifyApiKey, listLocalTemplates);
router.get('/templates/local/:templateId', verifyApiKey, getLocalTemplate);
router.post('/templates/pull', verifyApiKey, downloadTemplate);
router.delete('/templates/local/:templateId', verifyApiKey, deleteLocalTemplate);
router.post('/templates/publish', verifyApiKey, publishTemplate);
router.post('/templates/export', verifyApiKey, exportTemplate);
router.post('/templates/local/:templateId/move', verifyApiKey, moveTemplate);

// Fault Management Routes
router.get('/system/fault-management/faults', verifyApiKey, getFaults); // List system faults
router.get('/system/fault-management/faults/:uuid', verifyApiKey, getFaultDetails); // Get specific fault details
router.get('/system/fault-management/config', verifyApiKey, getFaultManagerConfig); // Get fault manager configuration
router.post('/system/fault-management/actions/acquit', verifyApiKey, acquitFault); // Acquit a fault
router.post('/system/fault-management/actions/repaired', verifyApiKey, markRepaired); // Mark resource as repaired
router.post('/system/fault-management/actions/replaced', verifyApiKey, markReplaced); // Mark resource as replaced

// System Log Management Routes
router.get('/system/logs/list', verifyApiKey, listLogFiles); // List available log files
router.get('/system/logs/:logname', verifyApiKey, getLogFile); // Read specific log file
router.get('/system/logs/fault-manager/:type', verifyApiKey, getFaultManagerLogs); // Read fault manager logs via fmdump

// Log Streaming Routes
router.post('/system/logs/:logname/stream/start', verifyApiKey, startLogStream); // Start log stream session
router.get('/system/logs/stream/sessions', verifyApiKey, listLogStreamSessions); // List active log stream sessions
router.get('/system/logs/stream/:sessionId', verifyApiKey, getLogStreamInfo); // Get log stream session info
router.delete('/system/logs/stream/:sessionId/stop', verifyApiKey, stopLogStream); // Stop log stream session

// Syslog Configuration Management Routes
router.get('/system/syslog/config', verifyApiKey, getSyslogConfig); // Get syslog configuration
router.put('/system/syslog/config', verifyApiKey, updateSyslogConfig); // Update syslog configuration
router.get('/system/syslog/facilities', verifyApiKey, getSyslogFacilities); // Get available facilities and levels
router.post('/system/syslog/validate', verifyApiKey, validateSyslogConfig); // Validate syslog configuration
router.post('/system/syslog/reload', verifyApiKey, reloadSyslogService); // Reload syslog service
router.post('/system/syslog/switch', verifyApiKey, switchSyslogService); // Switch between syslog implementations

// Process Management Routes
router.get('/system/processes', verifyApiKey, listProcesses); // List system processes
router.get('/system/processes/find', verifyApiKey, findProcessesController); // Find processes by pattern
router.get('/system/processes/stats', verifyApiKey, getProcessStatsController); // Get real-time process statistics
router.post('/system/processes/batch-kill', verifyApiKey, batchKillProcesses); // Kill multiple processes by pattern
router.post('/system/processes/trace/start', verifyApiKey, startProcessTrace); // Start process tracing (async task)
router.get('/system/processes/:pid', verifyApiKey, getProcessDetailsController); // Get detailed process information
router.post('/system/processes/:pid/signal', verifyApiKey, sendSignalToProcess); // Send signal to process
router.post('/system/processes/:pid/kill', verifyApiKey, killProcessController); // Kill a process
router.get('/system/processes/:pid/files', verifyApiKey, getProcessFilesController); // Get open files for process
router.get('/system/processes/:pid/stack', verifyApiKey, getProcessStackController); // Get process stack trace
router.get('/system/processes/:pid/limits', verifyApiKey, getProcessLimitsController); // Get process resource limits

// System User Management Routes
router.get('/system/user-info', verifyApiKey, getCurrentUserInfo); // Get current API user information
router.get('/system/users', verifyApiKey, getSystemUsers); // List system users
router.post('/system/users', verifyApiKey, createSystemUser); // Create new system user
router.put('/system/users/:username', verifyApiKey, modifySystemUser); // Modify system user
router.delete('/system/users/:username', verifyApiKey, deleteSystemUser); // Delete system user
router.post('/system/users/:username/password', verifyApiKey, setUserPassword); // Set user password
router.post('/system/users/:username/lock', verifyApiKey, lockUserAccount); // Lock user account
router.post('/system/users/:username/unlock', verifyApiKey, unlockUserAccount); // Unlock user account
router.get('/system/users/:username/attributes', verifyApiKey, getUserAttributes); // Get user RBAC attributes
router.get('/system/groups', verifyApiKey, getSystemGroups); // List system groups
router.post('/system/groups', verifyApiKey, createSystemGroup); // Create new system group
router.put('/system/groups/:groupname', verifyApiKey, modifySystemGroup); // Modify system group
router.delete('/system/groups/:groupname', verifyApiKey, deleteSystemGroup); // Delete system group
router.get('/system/roles', verifyApiKey, getSystemRoles); // List system roles
router.post('/system/roles', verifyApiKey, createSystemRole); // Create new system role
router.put('/system/roles/:rolename', verifyApiKey, modifySystemRole); // Modify system role
router.delete('/system/roles/:rolename', verifyApiKey, deleteSystemRole); // Delete system role
router.get('/system/rbac/authorizations', verifyApiKey, getAvailableAuthorizations); // List available RBAC authorizations
router.get('/system/rbac/profiles', verifyApiKey, getAvailableProfiles); // List available RBAC profiles
router.get('/system/rbac/roles', verifyApiKey, getAvailableRoles); // List available RBAC roles for assignment
router.get('/system/user-lookup', verifyApiKey, lookupUser); // Lookup user by UID or username
router.get('/system/group-lookup', verifyApiKey, lookupGroup); // Lookup group by GID or name

// Artifact Storage Management Routes
router.get('/artifacts/storage/paths', verifyApiKey, listStoragePaths); // List storage paths
router.post('/artifacts/storage/paths', verifyApiKey, createStoragePath); // Create storage path
router.put('/artifacts/storage/paths/:id', verifyApiKey, updateStoragePath); // Update storage path
router.delete('/artifacts/storage/paths/:id', verifyApiKey, deleteStoragePath); // Delete storage path
router.get('/artifacts', verifyApiKey, listArtifacts); // List all artifacts
router.get('/artifacts/iso', verifyApiKey, listISOArtifacts); // List ISO artifacts
router.get('/artifacts/image', verifyApiKey, listImageArtifacts); // List image artifacts
router.get('/artifacts/:id', verifyApiKey, getArtifactDetails); // Get artifact details
router.post('/artifacts/:id/move', verifyApiKey, moveArtifact); // Move artifact to another storage location
router.post('/artifacts/:id/copy', verifyApiKey, copyArtifact); // Copy artifact to another storage location
router.post('/artifacts/download', verifyApiKey, downloadFromUrl); // Download artifact from URL (async task)
router.post('/artifacts/upload/prepare', verifyApiKey, prepareArtifactUpload); // Prepare upload (returns task_id and upload_url)
router.post(
  '/artifacts/upload/:taskId',
  verifyApiKey,
  validateUploadRequest,
  uploadArtifactToTask,
  handleUploadError
); // Upload artifact file to prepared task
router.get('/artifacts/:id/download', verifyApiKey, downloadArtifact); // Stream download artifact file
router.post('/artifacts/scan', verifyApiKey, scanArtifacts); // Scan storage locations (async task)
router.delete('/artifacts/files', verifyApiKey, deleteArtifacts); // Delete artifact files (async task)
router.get('/artifacts/stats', verifyApiKey, getArtifactStats); // Get artifact statistics
router.get('/artifacts/service/status', verifyApiKey, getArtifactServiceStatus); // Get service status

// File System Management Routes
router.get('/filesystem', verifyApiKey, browseDirectory); // Browse directory contents
router.post('/filesystem/folder', verifyApiKey, createFolder); // Create directory
router.post(
  '/filesystem/upload',
  verifyApiKey,
  validateUploadRequest,
  uploadSingle('file'),
  uploadFile,
  handleUploadError
); // Upload file
router.get('/filesystem/download', verifyApiKey, downloadFile); // Download file
router.get('/filesystem/content', verifyApiKey, readFile); // Read text file content
router.put('/filesystem/content', verifyApiKey, writeFile); // Write text file content
router.put('/filesystem/move', verifyApiKey, moveFileItem); // Move/rename item (async task)
router.post('/filesystem/copy', verifyApiKey, copyFileItem); // Copy item (async task)
router.patch('/filesystem/rename', verifyApiKey, renameItem); // Rename item
router.delete('/filesystem', verifyApiKey, deleteFileItem); // Delete item
router.patch('/filesystem/permissions', verifyApiKey, changePermissions); // Change file/directory permissions
router.post('/filesystem/archive/create', verifyApiKey, createArchiveTask); // Create archive (async task)
router.post('/filesystem/archive/extract', verifyApiKey, extractArchiveTask); // Extract archive (async task)

// System Host Management Routes
router.get('/system/host/status', verifyApiKey, getSystemStatus); // Get comprehensive system status
router.get('/system/host/uptime', verifyApiKey, getSystemUptime); // Get detailed uptime information
router.get('/system/host/reboot-status', verifyApiKey, getRebootRequiredStatus); // Get reboot required status
router.delete('/system/host/reboot-status', verifyApiKey, clearRebootRequiredStatus); // Clear reboot flags

// Host Configuration Routes
router.get('/system/hosts', verifyApiKey, getHosts); // Get /etc/hosts entries
router.put('/system/hosts', verifyApiKey, updateHosts); // Update /etc/hosts entries
router.get('/system/dns', verifyApiKey, getDns); // Get DNS configuration (/etc/resolv.conf)
router.put('/system/dns', verifyApiKey, updateDns); // Update DNS configuration (/etc/resolv.conf)

// Database Management Routes
router.get('/database/stats', verifyApiKey, getDatabaseStats); // Get database statistics
router.post('/database/vacuum', verifyApiKey, vacuumDatabase); // Run SQLite VACUUM
router.post('/database/analyze', verifyApiKey, analyzeDatabase); // Run SQLite ANALYZE
router.post('/database/cleanup', verifyApiKey, triggerCleanup); // Trigger manual cleanup

// System Host Restart Operations (TaskQueue)
router.post('/system/host/restart', verifyApiKey, restartHost); // Gracefully restart host system
router.post('/system/host/reboot', verifyApiKey, rebootHost); // Direct reboot host system
router.post('/system/host/reboot/fast', verifyApiKey, fastRebootHost); // Fast reboot (x86 only)

// System Host Shutdown Operations (TaskQueue)
router.post('/system/host/shutdown', verifyApiKey, shutdownHost); // Gracefully shutdown to single-user
router.post('/system/host/poweroff', verifyApiKey, poweroffHost); // Power off system completely
router.post('/system/host/halt', verifyApiKey, haltHost); // Emergency immediate halt

// System Host Runlevel Operations (TaskQueue)
router.get('/system/host/runlevel', verifyApiKey, getCurrentRunlevel); // Get current runlevel
router.post('/system/host/runlevel', verifyApiKey, changeRunlevel); // Change to specific runlevel
router.post('/system/host/single-user', verifyApiKey, enterSingleUserMode); // Enter single-user mode
router.post('/system/host/multi-user', verifyApiKey, enterMultiUserMode); // Enter multi-user mode

export default router;
