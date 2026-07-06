/**
 * @fileoverview Process Controller for Zoneweaver Agent — aggregating index
 * @description Handles API requests for OmniOS process management. The implementation
 * lives in ./Process/ (query endpoints, action endpoints); this index preserves the
 * module's import path.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

export {
  listProcesses,
  getProcessDetailsController,
  getProcessFilesController,
  getProcessStackController,
  getProcessLimitsController,
  findProcessesController,
  getProcessStatsController,
} from './Process/ProcessQueryController.js';
export {
  sendSignalToProcess,
  killProcessController,
  batchKillProcesses,
  startProcessTrace,
} from './Process/ProcessActionController.js';
