/**
 * @fileoverview Zone Orchestration Control
 * @description Orchestration status detection, config persistence, and enable/disable control
 *              handoff between the system zones service and zoneweaver-agent.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { enableService, disableService, getServiceDetails } from '../ServiceManager.js';
import { extractZonePriority } from '../ZoneOrchestrationUtils.js';
import Zones from '../../models/ZoneModel.js';
import { log } from '../Logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import config from '../../config/ConfigLoader.js';

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
      const Tasks = (await import('../../models/TaskModel.js')).default;
      const { TaskPriority } = await import('../../models/TaskModel.js');

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
