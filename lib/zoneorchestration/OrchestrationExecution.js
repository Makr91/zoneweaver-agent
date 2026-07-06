/**
 * @fileoverview Zone Orchestration Execution
 * @description Executes priority-grouped zone startup and shutdown orchestration using
 *              existing zone start/stop task executors.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { executeStopTask, executeStartTask } from '../../controllers/TaskManager/ZoneManager.js';
import {
  calculateShutdownOrder,
  calculateStartupOrder,
  extractZonePriority,
} from '../ZoneOrchestrationUtils.js';
import Zones from '../../models/ZoneModel.js';
import { log, createTimer } from '../Logger.js';
import { getAutobootZones, getZonesForOrchestration } from './OrchestrationZoneQueries.js';

/**
 * Execute zone startup orchestration using existing zone start functions
 * @param {Array} specificZones - Specific zone names to start (optional)
 * @param {string} strategy - Orchestration strategy
 * @param {Object} options - Orchestration options
 * @returns {Promise<{success: boolean, zones_started?: Array, zones_failed?: Array, error?: string}>}
 */
export const executeZoneStartupOrchestration = async (
  specificZones = null,
  strategy = 'parallel_by_priority',
  options = {}
) => {
  const orchestrationTimer = createTimer('zone_startup_orchestration');

  try {
    log.monitoring.info('ZONE ORCHESTRATION: Starting startup orchestration', {
      strategy,
      options,
      specific_zones: specificZones,
    });

    let zonesResult;
    if (specificZones) {
      // Start specific zones that were provided (parallel database lookups)
      const zonePromises = specificZones.map(async zoneName => {
        const dbZone = await Zones.findOne({ where: { name: zoneName } });
        if (dbZone) {
          const priority = extractZonePriority(dbZone.configuration);
          const isAutoboot = dbZone.configuration?.autoboot === 'true';

          return {
            name: dbZone.name,
            state: dbZone.status,
            priority,
            autoboot: isAutoboot,
            configuration: dbZone.configuration || {},
          };
        }
        return null;
      });

      const zones = (await Promise.all(zonePromises)).filter(zone => zone !== null);
      zonesResult = { success: true, zones };
    } else {
      // Get all autoboot zones that should be started
      zonesResult = await getAutobootZones();
    }

    if (!zonesResult.success) {
      return { success: false, error: zonesResult.error };
    }

    if (zonesResult.zones.length === 0) {
      log.monitoring.info('No zones found for startup orchestration');
      return {
        success: true,
        zones_started: [],
        zones_failed: [],
        message: 'No zones to start',
      };
    }

    // Calculate startup order (highest priority first)
    const priorityGroups = calculateStartupOrder(zonesResult.zones);

    const results = {
      zones_started: [],
      zones_failed: [],
    };

    // Execute startup by priority groups (reverse order from shutdown)
    const groupPromises = priorityGroups.map(async (group, groupIndex) => {
      log.monitoring.info(`ZONE ORCHESTRATION: Starting priority group ${group.priority_range}`, {
        zones: group.zones.map(z => z.name),
        strategy,
      });

      // Apply delay before this group (except first group)
      if (groupIndex > 0 && options.priority_delay && options.priority_delay > 0) {
        await new Promise(resolve => {
          setTimeout(resolve, options.priority_delay * 1000);
        });
      }

      // Start all zones in group using existing executeStartTask
      const startPromises = group.zones.map(async zone => {
        const startResult = await executeStartTask(zone.name);
        return {
          zone: zone.name,
          priority: zone.priority,
          result: startResult,
        };
      });
      return Promise.all(startPromises);
    });

    // Wait for all groups to complete
    const allGroupResults = await Promise.all(groupPromises);

    // Process all results
    allGroupResults.flat().forEach(({ zone, priority, result }) => {
      if (result.success) {
        results.zones_started.push(zone);
      } else {
        results.zones_failed.push({
          zone,
          error: result.error,
          priority,
        });
      }
    });

    const duration = orchestrationTimer.end();
    const allStarted = results.zones_failed.length === 0;

    log.monitoring.info('ZONE ORCHESTRATION: Startup orchestration completed', {
      success: allStarted,
      zones_started: results.zones_started.length,
      zones_failed: results.zones_failed.length,
      strategy,
      duration_ms: duration,
    });

    return {
      success: allStarted,
      zones_started: results.zones_started,
      zones_failed: results.zones_failed,
      duration_ms: duration,
      message: allStarted
        ? `All ${results.zones_started.length} zones started successfully`
        : `${results.zones_started.length} zones started, ${results.zones_failed.length} failed`,
    };
  } catch (error) {
    orchestrationTimer.end();
    log.monitoring.error('ZONE ORCHESTRATION: Startup orchestration failed', {
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      error: `Zone startup orchestration failed: ${error.message}`,
    };
  }
};

/**
 * Execute zone shutdown orchestration using existing zone stop functions
 * @param {string} strategy - Orchestration strategy
 * @param {Object} options - Orchestration options
 * @returns {Promise<{success: boolean, zones_stopped?: Array, zones_failed?: Array, error?: string}>}
 */
export const executeZoneShutdownOrchestration = async (
  strategy = 'parallel_by_priority',
  options = {}
) => {
  const orchestrationTimer = createTimer('zone_shutdown_orchestration');

  try {
    log.monitoring.warn('ZONE ORCHESTRATION: Starting shutdown orchestration', {
      strategy,
      options,
    });

    // Get running zones using existing functionality
    const zonesResult = await getZonesForOrchestration('running');
    if (!zonesResult.success) {
      return { success: false, error: zonesResult.error };
    }

    if (zonesResult.zones.length === 0) {
      log.monitoring.info('No running zones found for orchestration');
      return {
        success: true,
        zones_stopped: [],
        zones_failed: [],
        message: 'No running zones to orchestrate',
      };
    }

    // Calculate shutdown order using priority utilities
    const priorityGroups = calculateShutdownOrder(zonesResult.zones);

    const results = {
      zones_stopped: [],
      zones_failed: [],
    };

    // Execute shutdown by priority groups using Promise.all for parallel execution
    const groupPromises = priorityGroups.map(async (group, groupIndex) => {
      log.monitoring.info(`ZONE ORCHESTRATION: Stopping priority group ${group.priority_range}`, {
        zones: group.zones.map(z => z.name),
        strategy,
      });

      // Apply delay before this group (except first group)
      if (groupIndex > 0 && options.priority_delay && options.priority_delay > 0) {
        await new Promise(resolve => {
          setTimeout(resolve, options.priority_delay * 1000);
        });
      }

      if (strategy === 'sequential') {
        // Even for sequential strategy, we can parallelize within the group
        const stopPromises = group.zones.map(async zone => {
          const stopResult = await executeStopTask(zone.name);
          return {
            zone: zone.name,
            priority: zone.priority,
            result: stopResult,
          };
        });
        return Promise.all(stopPromises);
      }
      // Parallel - stop all zones in group simultaneously
      const stopPromises = group.zones.map(async zone => {
        const stopResult = await executeStopTask(zone.name);
        return {
          zone: zone.name,
          priority: zone.priority,
          result: stopResult,
        };
      });
      return Promise.all(stopPromises);
    });

    // Wait for all groups to complete
    const allGroupResults = await Promise.all(groupPromises);

    // Process all results
    allGroupResults.flat().forEach(({ zone, priority, result }) => {
      if (result.success) {
        results.zones_stopped.push(zone);
      } else {
        results.zones_failed.push({
          zone,
          error: result.error,
          priority,
        });
      }
    });

    // Check if we should abort on failures
    if (results.zones_failed.length > 0 && options.failure_action === 'abort') {
      const duration = orchestrationTimer.end();
      return {
        success: false,
        error: `${results.zones_failed.length} zones failed to stop, aborting orchestration`,
        zones_stopped: results.zones_stopped,
        zones_failed: results.zones_failed,
        duration_ms: duration,
      };
    }

    const duration = orchestrationTimer.end();
    const allStopped = results.zones_failed.length === 0;

    log.monitoring.warn('ZONE ORCHESTRATION: Shutdown orchestration completed', {
      success: allStopped,
      zones_stopped: results.zones_stopped.length,
      zones_failed: results.zones_failed.length,
      strategy,
      duration_ms: duration,
    });

    return {
      success: allStopped,
      zones_stopped: results.zones_stopped,
      zones_failed: results.zones_failed,
      duration_ms: duration,
      message: allStopped
        ? `All ${results.zones_stopped.length} zones stopped successfully`
        : `${results.zones_stopped.length} zones stopped, ${results.zones_failed.length} failed`,
    };
  } catch (error) {
    orchestrationTimer.end();
    log.monitoring.error('ZONE ORCHESTRATION: Shutdown orchestration failed', {
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      error: `Zone shutdown orchestration failed: ${error.message}`,
    };
  }
};
