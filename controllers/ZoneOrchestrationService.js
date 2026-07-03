/**
 * @fileoverview Zone Orchestration Service for Zoneweaver Agent
 * @description Handles zone orchestration startup and service management
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import config from '../config/ConfigLoader.js';
import { log } from '../lib/Logger.js';
import { executeDiscoverTask } from './TaskManager/ZoneManager.js';
import { getAutobootZones, getZonesForOrchestration } from '../lib/ZoneOrchestrationManager.js';
import { isVncEnabledAtBoot } from './VncConsoleController/utils/VncCleanupService.js';
import { sessionManager } from './VncConsoleController/utils/VncSessionManager.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';

/**
 * Start zone orchestration service
 * @description Checks orchestration configuration and starts autoboot zones if enabled
 * @returns {Promise<void>}
 */
export const startZoneOrchestration = async () => {
  try {
    const orchestrationConfig = config.getZoneOrchestration();

    if (!orchestrationConfig.enabled) {
      log.monitoring.debug('Zone orchestration disabled in configuration');
      return;
    }

    log.monitoring.info('Zone orchestration enabled - running discovery first');

    // Force zone discovery to ensure database has fresh configuration data
    const discoveryResult = await executeDiscoverTask();

    if (discoveryResult.success) {
      log.monitoring.info('Zone discovery completed - checking autoboot zones');
    } else {
      log.monitoring.warn('Zone discovery failed during startup', {
        error: discoveryResult.error,
      });
    }

    const autobootZones = await getAutobootZones();

    if (autobootZones.success && autobootZones.zones.length > 0) {
      log.monitoring.info('Zone orchestration startup initiated', {
        autoboot_zones_found: autobootZones.zones.length,
        zones: autobootZones.zones.map(z => ({ name: z.name, priority: z.priority })),
      });

      // Create start tasks for each autoboot zone in priority order (highest first)
      const sortedZones = autobootZones.zones.sort((a, b) => b.priority - a.priority);

      // Create all tasks in parallel for optimal performance
      const taskPromises = sortedZones.map(zone => {
        log.monitoring.debug('Zone start task created for autoboot', {
          zone_name: zone.name,
          priority: zone.priority,
        });

        return Tasks.create({
          zone_name: zone.name,
          operation: 'start',
          priority: TaskPriority.HIGH,
          created_by: 'orchestration_startup',
          status: 'pending',
        });
      });

      await Promise.all(taskPromises);

      log.monitoring.info('Zone orchestration startup tasks created', {
        zones_queued: sortedZones.length,
        startup_action: 'zone_orchestration_startup',
      });
    } else {
      log.monitoring.info('Zone orchestration enabled but no autoboot zones found');
    }

    // Scenario 2: Check already-running zones for missing VNC sessions
    log.monitoring.info('Checking running zones for missing VNC sessions');

    const runningZonesResult = await getZonesForOrchestration('running');

    if (runningZonesResult.success && runningZonesResult.zones.length > 0) {
      log.monitoring.info('Found running zones, checking for missing VNC sessions', {
        running_zones_count: runningZonesResult.zones.length,
        zones: runningZonesResult.zones.map(z => z.name),
      });

      // Check each running zone for VNC auto-start eligibility
      const vncCheckPromises = runningZonesResult.zones.map(async zone => {
        try {
          const vncEnabled = await isVncEnabledAtBoot(zone.name);
          const hasVncSession = sessionManager.getSessionInfo(zone.name);

          return {
            zone_name: zone.name,
            vnc_enabled: vncEnabled,
            has_session: !!hasVncSession,
            needs_vnc: vncEnabled && !hasVncSession,
          };
        } catch (error) {
          log.monitoring.warn('Failed to check VNC status for running zone', {
            zone_name: zone.name,
            error: error.message,
          });
          return {
            zone_name: zone.name,
            vnc_enabled: false,
            has_session: false,
            needs_vnc: false,
          };
        }
      });

      const vncResults = await Promise.all(vncCheckPromises);
      const zonesNeedingVnc = vncResults.filter(result => result.needs_vnc);

      if (zonesNeedingVnc.length > 0) {
        log.monitoring.info('Creating auto-VNC tasks for running zones', {
          zones_needing_vnc: zonesNeedingVnc.length,
          zones: zonesNeedingVnc.map(z => z.zone_name),
        });

        // Create VNC start tasks for running zones that need them
        const vncTaskPromises = zonesNeedingVnc.map(zoneResult => {
          log.monitoring.debug('Creating VNC start task for running zone', {
            zone_name: zoneResult.zone_name,
          });

          return Tasks.create({
            zone_name: zoneResult.zone_name,
            operation: 'vnc_start',
            priority: TaskPriority.LOW,
            created_by: 'orchestration_startup_vnc',
            status: 'pending',
          });
        });

        await Promise.all(vncTaskPromises);

        log.monitoring.info('Auto-VNC startup tasks created for running zones', {
          vnc_tasks_created: zonesNeedingVnc.length,
        });
      } else {
        log.monitoring.info('No running zones need VNC sessions');
      }
    } else {
      log.monitoring.info('No running zones found to check for VNC');
    }
  } catch (error) {
    log.monitoring.error('Error during zone orchestration startup', {
      error: error.message,
      stack: error.stack,
    });
  }
};

/**
 * Get zone orchestration service status
 * @description Returns status of zone orchestration feature
 * @returns {Object} Service status information
 */
export const getZoneOrchestrationServiceStatus = () => {
  const orchestrationConfig = config.getZoneOrchestration();

  return {
    name: 'zone_orchestration',
    enabled: orchestrationConfig.enabled,
    type: 'startup_action',
    description: 'Zone orchestration startup service - starts autoboot zones in priority order',
  };
};
