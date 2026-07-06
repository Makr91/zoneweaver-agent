/**
 * @fileoverview Zone Orchestration Zone Queries
 * @description Retrieves autoboot zones and zones by state from the existing database
 *              for priority-based orchestration.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { extractZonePriority } from '../ZoneOrchestrationUtils.js';
import Zones from '../../models/ZoneModel.js';
import { log } from '../Logger.js';

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
    const { executeDiscoverTask } = await import('../../controllers/TaskManager/ZoneManager.js');
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
