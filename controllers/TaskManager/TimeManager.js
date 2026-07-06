/**
 * @fileoverview Time Manager for Time Synchronization Operations — aggregating index
 * @description Handles time sync configuration, force sync, timezone setting, and system
 * switching. The implementation lives in ./Time/; this index preserves the module's
 * import path.
 */

export {
  executeUpdateTimeSyncConfigTask,
  executeForceTimeSyncTask,
} from './Time/TimeSyncTaskManager.js';
export { executeSetTimezoneTask } from './Time/TimezoneTaskManager.js';
export {
  extractServersFromConfig,
  generateConfigForSystem,
  executeSwitchTimeSyncSystemTask,
} from './Time/TimeSyncSystemSwitchManager.js';
