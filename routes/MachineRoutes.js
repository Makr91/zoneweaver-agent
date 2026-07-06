import { verifyApiKey } from '../middleware/VerifyApiKey.js';
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
  getZoneOrchestrationStatus,
  enableOrchestration,
  disableOrchestration,
  getZonePriorities,
  testOrchestration,
} from '../controllers/ZoneOrchestrationController.js';
import {
  provisionZone,
  getProvisioningStatus as getZoneProvisioningStatus,
  syncZone,
  runProvisioners,
} from '../controllers/ProvisioningOrchestrationController/index.js';
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

/**
 * @fileoverview Machine routes — machine lifecycle/orchestration, task queue,
 * and console sessions (VNC, host terminal, zlogin, SSH).
 */

/**
 * Register the machine lifecycle, orchestration, and task queue routes.
 * @param {import('express').Router} router - Application router
 */
const registerLifecycleRoutes = router => {
  // Zone Orchestration Management Routes (MUST come before parameterized routes)
  router.get('/machines/orchestration/status', verifyApiKey, getZoneOrchestrationStatus); // Get orchestration control status
  router.post('/machines/orchestration/enable', verifyApiKey, enableOrchestration); // Enable zone orchestration control
  router.post('/machines/orchestration/disable', verifyApiKey, disableOrchestration); // Disable zone orchestration control
  router.get('/machines/priorities', verifyApiKey, getZonePriorities); // List all zones with priorities
  router.post('/machines/orchestration/test', verifyApiKey, testOrchestration); // Test orchestration (dry run)

  // Bulk Zone Operations (MUST come before parameterized routes)
  router.post('/machines/bulk/start', verifyApiKey, bulkStartZones); // Bulk start zones
  router.post('/machines/bulk/stop', verifyApiKey, bulkStopZones); // Bulk stop zones

  // Zone Server ID Discovery Routes (must come before parameterized routes)
  router.get('/machines/ids/next', verifyApiKey, getNextServerId); // Get next available server ID
  router.get('/machines/ids', verifyApiKey, getServerIds); // Get server ID usage information

  // Zone Creation & Modification Routes (must come before parameterized routes)
  router.post('/machines', verifyApiKey, createZone); // Create a new zone
  router.put('/machines/:machineName', verifyApiKey, modifyZone); // Modify zone configuration

  // Zone Management Routes (parameterized routes come after specific routes)
  router.get('/machines', verifyApiKey, listZones); // List all zones
  router.get('/machines/:machineName', verifyApiKey, getZoneDetails); // Get zone details
  router.get('/machines/:machineName/config', verifyApiKey, getZoneConfig); // Get zone configuration
  router.get('/machines/:machineName/notes', verifyApiKey, getZoneNotes); // Get zone notes
  router.put('/machines/:machineName/notes', verifyApiKey, updateZoneNotes); // Update zone notes
  router.get('/machines/:machineName/tags', verifyApiKey, getZoneTags); // Get zone tags
  router.put('/machines/:machineName/tags', verifyApiKey, updateZoneTags); // Update zone tags
  router.post('/machines/:machineName/start', verifyApiKey, startZone); // Start zone
  router.post('/machines/:machineName/stop', verifyApiKey, stopZone); // Stop zone
  router.post('/machines/:machineName/restart', verifyApiKey, restartZone); // Restart zone
  router.delete('/machines/:machineName', verifyApiKey, deleteZone); // Delete zone
  router.post('/machines/:machineName/clone', verifyApiKey, cloneZone); // Clone zone

  // Zone Provisioning Routes
  router.post('/machines/:name/provision', verifyApiKey, provisionZone); // Start provisioning pipeline
  router.get('/machines/:name/provision/status', verifyApiKey, getZoneProvisioningStatus); // Get provisioning status
  router.post('/machines/:name/sync', verifyApiKey, syncZone); // Sync provisioning files ad-hoc
  router.post('/machines/:name/run-provisioners', verifyApiKey, runProvisioners); // Run provisioners ad-hoc

  // Task Management Routes
  router.get('/tasks', verifyApiKey, listTasks); // List tasks (supports ?sort=&order= params)
  router.get('/tasks/stats', verifyApiKey, getTaskStats); // Get task statistics
  router.delete('/tasks/completed', verifyApiKey, clearCompletedTasks); // Hard-delete all completed/failed/cancelled tasks
  router.get('/tasks/:taskId', verifyApiKey, getTaskDetails); // Get task details
  router.get('/tasks/:taskId/output', verifyApiKey, getTaskOutput); // Get task output
  router.delete('/tasks/:taskId', verifyApiKey, cancelTask); // Cancel task
};

/**
 * Register the console session routes (VNC, host terminal, zlogin, SSH).
 * @param {import('express').Router} router - Application router
 */
const registerConsoleRoutes = router => {
  // VNC Console Management Routes
  router.post('/machines/:machineName/vnc/start', verifyApiKey, startVncSession); // Start VNC session
  router.get('/machines/:machineName/vnc/info', verifyApiKey, getVncSessionInfo); // Get VNC session info
  router.delete('/machines/:machineName/vnc/stop', verifyApiKey, stopVncSession); // Stop VNC session
  router.get('/machines/:machineName/vnc/screenshot', verifyApiKey, getVncScreenshot); // Capture VNC console screenshot (PNG)
  router.get('/vnc/sessions', verifyApiKey, listVncSessions); // List all VNC sessions

  // Terminal Routes
  router.post('/terminal/start', verifyApiKey, startTerminalSession);
  router.get('/terminal/sessions', verifyApiKey, listTerminalSessions);
  router.get('/terminal/sessions/:terminal_cookie/health', verifyApiKey, checkSessionHealth);
  router.get('/terminal/sessions/:sessionId', verifyApiKey, getTerminalSessionInfo);
  router.delete('/terminal/sessions/:sessionId/stop', verifyApiKey, stopTerminalSession);

  // Zlogin Routes
  router.post('/machines/:machineName/zlogin/start', verifyApiKey, startZloginSession);
  router.get('/zlogin/sessions', verifyApiKey, listZloginSessions);
  router.get('/zlogin/sessions/:sessionId', verifyApiKey, getZloginSessionInfo);
  router.delete('/zlogin/sessions/:sessionId/stop', verifyApiKey, stopZloginSession);

  // SSH Terminal Routes
  router.post('/machines/:machineName/ssh/start', verifyApiKey, startSSHSession);
  router.get('/ssh/sessions', verifyApiKey, listSSHSessions);
  router.get('/ssh/sessions/:sessionId', verifyApiKey, getSSHSessionInfo);
  router.delete('/ssh/sessions/:sessionId/stop', verifyApiKey, stopSSHSession);
};

/**
 * Register the machine, task, and console route set on the shared router.
 * @param {import('express').Router} router - Application router
 */
export const registerMachineRoutes = router => {
  registerLifecycleRoutes(router);
  registerConsoleRoutes(router);
};
