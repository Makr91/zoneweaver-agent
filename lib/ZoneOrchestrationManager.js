/**
 * @fileoverview Zone Orchestration Manager
 * @description Coordinates existing zone functions for priority-based orchestration
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { executeStopTask, executeStartTask } from '../controllers/TaskManager/ZoneManager.js';
import { enableService, disableService, getServiceDetails } from './ServiceManager.js';
import {
  calculateShutdownOrder,
  calculateStartupOrder,
  extractZonePriority,
} from './ZoneOrchestrationUtils.js';
import Zones from '../models/ZoneModel.js';
import { log, createTimer } from './Logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import config from '../config/ConfigLoader.js';

/**
 * Check if zone orchestration is enabled and who controls zones
 * @returns {Promise<{orchestration_enabled: boolean, zones_service_enabled: boolean, controller: string}>}
 */
export const getOrchestrationStatus = async () => {
  try {
    const zonesServiceDetails = await getServiceDetails('svc:/system/zones:default');
    const zonesServiceEnabled = zonesServiceDetails && zonesServiceDetails.state === 'online';

    return {
      orchestration_enabled: !zonesServiceEnabled,
      zones_service_enabled: zonesServiceEnabled,
      controller: zonesServiceEnabled ? 'system/zones' : 'zoneweaver-agent',
    };
  } catch (error) {
    log.monitoring.error('Error checking orchestration status', {
      error: error.message,
    });
    return {
      orchestration_enabled: false,
      zones_service_enabled: true,
      controller: 'unknown',
    };
  }
};

/**
 * Update zone orchestration enabled setting in config.yaml (uses existing pattern)
 * @param {boolean} enabled - Whether orchestration should be enabled
 * @returns {Promise<{success: boolean, error?: string}>}
 */
const updateOrchestrationConfig = async enabled => {
  try {
    const configPath = process.env.CONFIG_PATH || path.join(process.cwd(), 'config', 'config.yaml');

    // REUSE existing config update pattern from SettingsController.js
    const currentConfig = yaml.load(await fs.readFile(configPath, 'utf8'));

    // Ensure zones.orchestration structure exists
    if (!currentConfig.zones) {
      currentConfig.zones = {};
    }
    if (!currentConfig.zones.orchestration) {
      currentConfig.zones.orchestration = {};
    }

    // Update orchestration enabled setting
    currentConfig.zones.orchestration.enabled = enabled;

    // REUSE existing atomic update pattern
    const tempConfigPath = `${configPath}.tmp`;
    await fs.writeFile(tempConfigPath, yaml.dump(currentConfig), 'utf8');
    await fs.rename(tempConfigPath, configPath);

    // Reload configuration
    config.load();

    log.monitoring.info('Zone orchestration configuration updated', {
      orchestration_enabled: enabled,
    });

    return { success: true };
  } catch (error) {
    log.monitoring.error('Failed to update zone orchestration configuration', {
      error: error.message,
      enabled,
    });
    return { success: false, error: error.message };
  }
};

/**
 * Get autoboot zones that should be started (uses existing database)
 * @returns {Promise<{success: boolean, zones?: Array, error?: string}>}
 */
export const getAutobootZones = async () => {
  try {
    // REUSE existing database to get stopped zones that should autoboot
    const dbZones = await Zones.findAll({
      where: {
        status: 'installed', // Only zones that are stopped but ready to start
        is_orphaned: false,
      },
    });

    // Process all zones to check autoboot status (parse JSON configuration first)
    const autobootZones = dbZones
      .map(dbZone => {
        // Parse JSON configuration from database (stored as TEXT in SQLite)
        let zoneConfig = {};
        try {
          zoneConfig = JSON.parse(dbZone.configuration || '{}');
        } catch (error) {
          log.monitoring.warn('Failed to parse zone configuration JSON', {
            zone_name: dbZone.name,
            error: error.message,
          });
          zoneConfig = {};
        }

        const isAutoboot = zoneConfig.autoboot === 'true';

        if (isAutoboot) {
          const priority = extractZonePriority(zoneConfig);

          return {
            name: dbZone.name,
            state: dbZone.status,
            priority,
            autoboot: isAutoboot,
            configuration: zoneConfig,
          };
        }
        return null;
      })
      .filter(zone => zone !== null);

    log.monitoring.info('Autoboot zones identified', {
      total_zones: dbZones.length,
      autoboot_zones: autobootZones.length,
      zones: autobootZones.map(z => ({ name: z.name, priority: z.priority })),
    });

    return { success: true, zones: autobootZones };
  } catch (error) {
    log.monitoring.error('Error getting autoboot zones', {
      error: error.message,
    });
    return { success: false, error: error.message };
  }
};

/**
 * Enable zone orchestration (take control from zones service)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const enableZoneOrchestration = async () => {
  try {
    const currentStatus = await getOrchestrationStatus();

    if (currentStatus.orchestration_enabled) {
      return {
        success: true,
        message: 'Zone orchestration already enabled',
      };
    }

    // Get list of running zones from existing database (REUSE existing data)
    const runningZones = [];
    try {
      const runningDbZones = await Zones.findAll({
        where: {
          status: 'running',
          is_orphaned: false,
        },
      });

      runningZones.push(...runningDbZones.map(zone => zone.name));
    } catch (error) {
      log.monitoring.warn('Failed to get running zones from database before service disable', {
        error: error.message,
      });
    }

    // Update config.yaml to persist orchestration enabled state
    const configUpdateResult = await updateOrchestrationConfig(true);
    if (!configUpdateResult.success) {
      log.monitoring.warn('Failed to update orchestration config, proceeding anyway', {
        error: configUpdateResult.error,
      });
    }

    // Disable zones service
    const disableResult = await disableService('svc:/system/zones:default');
    if (!disableResult.success) {
      return {
        success: false,
        error: `Failed to disable zones service: ${disableResult.error}`,
      };
    }

    log.monitoring.warn('Zone orchestration enabled - Zoneweaver now controls zone lifecycle', {
      previous_controller: 'system/zones',
      new_controller: 'zoneweaver-agent',
      running_zones_before: runningZones.length,
      config_updated: configUpdateResult.success,
    });

    // Start zones that were running before we took control
    if (runningZones.length > 0) {
      log.monitoring.info('Starting zones that were running before orchestration enabled', {
        zones: runningZones,
      });

      // Create individual start tasks for zones that were running
      const Tasks = (await import('../models/TaskModel.js')).default;
      const { TaskPriority } = await import('../models/TaskModel.js');

      // Create start tasks in priority order (highest first)
      const zonePromises = runningZones.map(async zoneName => {
        const dbZone = await Zones.findOne({ where: { name: zoneName } });
        if (dbZone) {
          const priority = extractZonePriority(dbZone.configuration);
          return { name: zoneName, priority };
        }
        return null;
      });

      const zonesWithPriority = (await Promise.all(zonePromises)).filter(zone => zone !== null);

      const sortedZones = zonesWithPriority.sort((a, b) => b.priority - a.priority);

      // Create all tasks in parallel (performance optimization)
      const taskPromises = sortedZones.map(zone =>
        Tasks.create({
          zone_name: zone.name,
          operation: 'start',
          priority: TaskPriority.HIGH,
          created_by: 'orchestration_enable',
          status: 'pending',
        })
      );

      await Promise.all(taskPromises);

      return {
        success: true,
        message: `Zone orchestration enabled successfully - ${runningZones.length} zone start tasks created`,
        zones_queued: sortedZones.map(z => z.name),
      };
    }

    return {
      success: true,
      message: 'Zone orchestration enabled successfully - Zoneweaver now controls zone lifecycle',
    };
  } catch (error) {
    log.monitoring.error('Error enabling zone orchestration', {
      error: error.message,
    });
    return {
      success: false,
      error: `Failed to enable zone orchestration: ${error.message}`,
    };
  }
};

/**
 * Disable zone orchestration (return control to zones service)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const disableZoneOrchestration = async () => {
  try {
    const currentStatus = await getOrchestrationStatus();

    if (!currentStatus.orchestration_enabled) {
      return {
        success: true,
        message: 'Zone orchestration already disabled',
      };
    }

    // Update config.yaml to persist orchestration disabled state
    const configUpdateResult = await updateOrchestrationConfig(false);
    if (!configUpdateResult.success) {
      log.monitoring.warn('Failed to update orchestration config, proceeding anyway', {
        error: configUpdateResult.error,
      });
    }

    // Re-enable zones service
    const enableResult = await enableService('svc:/system/zones:default');
    if (!enableResult.success) {
      return {
        success: false,
        error: `Failed to enable zones service: ${enableResult.error}`,
      };
    }

    log.monitoring.info('Zone orchestration disabled - returning control to zones service', {
      previous_controller: 'zoneweaver-agent',
      new_controller: 'system/zones',
      config_updated: configUpdateResult.success,
    });

    return {
      success: true,
      message: 'Zone orchestration disabled successfully - zones service resumed control',
    };
  } catch (error) {
    log.monitoring.error('Error disabling zone orchestration', {
      error: error.message,
    });
    return {
      success: false,
      error: `Failed to disable zone orchestration: ${error.message}`,
    };
  }
};

/**
 * Get zones from existing database and zone discovery data (reuses existing functionality)
 * @param {string} targetState - Target zone state to filter by (default: 'running')
 * @returns {Promise<{success: boolean, zones?: Array, error?: string}>}
 */
export const getZonesForOrchestration = async (targetState = 'running') => {
  try {
    // REUSE existing database instead of running commands again
    const dbZones = await Zones.findAll({
      where: {
        status: targetState,
        is_orphaned: false,
      },
    });

    if (dbZones.length === 0) {
      return {
        success: true,
        zones: [],
        message: `No ${targetState} zones found in database`,
      };
    }

    // REUSE existing zone discovery task to get fresh config if needed
    const { executeDiscoverTask } = await import('../controllers/TaskManager/ZoneManager.js');
    const discoveryResult = await executeDiscoverTask();

    if (!discoveryResult.success) {
      log.monitoring.warn('Zone discovery failed during orchestration', {
        error: discoveryResult.error,
      });
      // Continue with database data even if discovery fails
    }

    // Get zones with configuration data from discovery
    const zones = [];

    for (const dbZone of dbZones) {
      // Use existing zone configuration from database/discovery
      // The discovery task already populates zone configs via zadm show
      const priority = extractZonePriority(dbZone.configuration);
      const isAutoboot = dbZone.configuration?.autoboot === 'true';

      zones.push({
        name: dbZone.name,
        state: dbZone.status,
        priority,
        autoboot: isAutoboot,
        configuration: dbZone.configuration || {},
      });
    }

    return { success: true, zones };
  } catch (error) {
    log.monitoring.error('Error getting zones for orchestration', {
      error: error.message,
      target_state: targetState,
    });
    return { success: false, error: error.message };
  }
};

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
