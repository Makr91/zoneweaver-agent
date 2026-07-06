/**
 * @fileoverview Zone Lifecycle Manager for Zoneweaver Agent — aggregating index
 * @description Executes zone lifecycle operations: start, stop, restart, delete, discover with dataset cleanup.
 * The implementation lives in ./Zone/ (lifecycle, dataset cleanup, deletion, discovery);
 * this index preserves the module's import path.
 * CRITICAL: NO BACKWARD COMPATIBILITY - Hosts.yml structure ONLY (settings/zones/networks/disks/provisioner)
 */
import {
  executeStartTask,
  executeStopTask,
  executeRestartTask,
} from './Zone/ZoneLifecycleTasks.js';
import { executeDeleteTask } from './Zone/ZoneDeletionTasks.js';
import { executeDiscoverTask } from './Zone/ZoneDiscoveryTask.js';

export {
  executeStartTask,
  executeStopTask,
  executeRestartTask,
  executeDeleteTask,
  executeDiscoverTask,
};
