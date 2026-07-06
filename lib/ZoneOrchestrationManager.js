/**
 * @fileoverview Zone Orchestration Manager — aggregating index
 * @description Coordinates existing zone functions for priority-based orchestration.
 * The implementation lives in ./zoneorchestration/ (control, zone queries, execution);
 * this index preserves the module's import path.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import {
  getOrchestrationStatus,
  enableZoneOrchestration,
  disableZoneOrchestration,
} from './zoneorchestration/OrchestrationControl.js';
import {
  getAutobootZones,
  getZonesForOrchestration,
} from './zoneorchestration/OrchestrationZoneQueries.js';
import {
  executeZoneStartupOrchestration,
  executeZoneShutdownOrchestration,
} from './zoneorchestration/OrchestrationExecution.js';

export {
  getOrchestrationStatus,
  getAutobootZones,
  enableZoneOrchestration,
  disableZoneOrchestration,
  getZonesForOrchestration,
  executeZoneStartupOrchestration,
  executeZoneShutdownOrchestration,
};
