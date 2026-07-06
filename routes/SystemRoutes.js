import { verifyApiKey } from '../middleware/VerifyApiKey.js';
import {
  listServices,
  getServiceDetailsController,
  serviceAction,
  getPropertiesController,
} from '../controllers/ServicesController.js';
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

/**
 * @fileoverview System routes — SMF services, packages/updates, boot
 * environments, repositories, time sync/timezone, fault management, system
 * logs, log streaming, syslog, and processes.
 */

/**
 * Register the SMF service and software management routes (packages, updates,
 * boot environments, repositories).
 * @param {import('express').Router} router - Application router
 */
const registerSoftwareRoutes = router => {
  // Service Management Routes (ordered from most specific to least specific)
  router.get('/services', verifyApiKey, listServices);
  router.post('/services/action', verifyApiKey, serviceAction);
  router.get('/services/:fmri/properties', verifyApiKey, getPropertiesController);
  router.get('/services/:fmri', verifyApiKey, getServiceDetailsController);

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
};

/**
 * Register the time synchronization, timezone, and fault management routes.
 * @param {import('express').Router} router - Application router
 */
const registerTimeFaultRoutes = router => {
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

  // Fault Management Routes
  router.get('/system/fault-management/faults', verifyApiKey, getFaults); // List system faults
  router.get('/system/fault-management/faults/:uuid', verifyApiKey, getFaultDetails); // Get specific fault details
  router.get('/system/fault-management/config', verifyApiKey, getFaultManagerConfig); // Get fault manager configuration
  router.post('/system/fault-management/actions/acquit', verifyApiKey, acquitFault); // Acquit a fault
  router.post('/system/fault-management/actions/repaired', verifyApiKey, markRepaired); // Mark resource as repaired
  router.post('/system/fault-management/actions/replaced', verifyApiKey, markReplaced); // Mark resource as replaced
};

/**
 * Register the system log, log streaming, syslog, and process routes.
 * @param {import('express').Router} router - Application router
 */
const registerLogProcessRoutes = router => {
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
};

/**
 * Register the system management route set on the shared router.
 * @param {import('express').Router} router - Application router
 */
export const registerSystemRoutes = router => {
  registerSoftwareRoutes(router);
  registerTimeFaultRoutes(router);
  registerLogProcessRoutes(router);
};
