/**
 * @fileoverview System Host Controller Entry Point
 * @description Central export point for all system host management functionality
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

// Status and Monitoring Operations (Direct - no TaskQueue)
export {
  getSystemStatus,
  getSystemUptime,
  getRebootRequiredStatus,
  clearRebootRequiredStatus,
} from './StatusController.js';

// Restart Operations (TaskQueue)
export { restartHost, rebootHost, fastRebootHost } from './RestartController.js';

// Shutdown Operations (TaskQueue)
export { shutdownHost, poweroffHost, haltHost } from './ShutdownController.js';

// Init/Runlevel Operations (TaskQueue)
export {
  getCurrentRunlevel,
  changeRunlevel,
  enterSingleUserMode,
  enterMultiUserMode,
} from './InitController.js';
