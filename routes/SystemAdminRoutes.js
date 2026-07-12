import { verifyApiKey } from '../middleware/VerifyApiKey.js';
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
import { getHosts, updateHosts, getDns, updateDns } from '../controllers/HostConfigController.js';
import {
  getDatabaseStats,
  vacuumDatabase,
  analyzeDatabase,
  triggerCleanup,
  listDatabaseTables,
  browseDatabaseTable,
} from '../controllers/DatabaseController.js';

/**
 * @fileoverview System administration routes — system accounts (users/groups/
 * roles/RBAC), host status/power/runlevel, hosts/DNS config, and database
 * maintenance.
 */

/**
 * Register the system administration route set on the shared router.
 * @param {import('express').Router} router - Application router
 */
export const registerSystemAdminRoutes = router => {
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
  router.get('/database/:db/tables', verifyApiKey, listDatabaseTables); // Explorer: list a database's tables
  router.get('/database/:db/tables/:table/rows', verifyApiKey, browseDatabaseTable); // Explorer: paged read-only row browser

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
};
