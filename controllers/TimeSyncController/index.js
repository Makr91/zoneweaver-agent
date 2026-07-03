/**
 * @fileoverview Time Sync Controller Index
 * @description Main entry point for time synchronization controllers
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

// Import status functions
import { getTimeSyncStatus, getAvailableTimeSyncSystems } from './StatusController.js';

// Import configuration functions
import { getTimeSyncConfig, updateTimeSyncConfig } from './ConfigController.js';

// Import sync operations
import { forceTimeSync, switchTimeSyncSystem } from './SyncController.js';

// Import timezone functions
import { getTimezone, setTimezone, listTimezones } from './TimezoneController.js';

// Export all functions for backward compatibility
export {
  // Status operations
  getTimeSyncStatus,
  getAvailableTimeSyncSystems,

  // Configuration operations
  getTimeSyncConfig,
  updateTimeSyncConfig,

  // Sync operations
  forceTimeSync,
  switchTimeSyncSystem,

  // Timezone operations
  getTimezone,
  setTimezone,
  listTimezones,
};

// Default export for compatibility
export default {
  // Status operations
  getTimeSyncStatus,
  getAvailableTimeSyncSystems,

  // Configuration operations
  getTimeSyncConfig,
  updateTimeSyncConfig,

  // Sync operations
  forceTimeSync,
  switchTimeSyncSystem,

  // Timezone operations
  getTimezone,
  setTimezone,
  listTimezones,
};
