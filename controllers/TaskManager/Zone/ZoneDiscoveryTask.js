/**
 * @fileoverview Zone Discovery Task Executor for Zoneweaver Agent
 * @description Discovers zones on the system, syncs them to the database, and marks orphans.
 */
import { executeCommand } from '../../../lib/CommandManager.js';
import { getAllZoneConfigs, preserveUserConfig } from '../../../lib/ZoneConfigUtils.js';
import Zones from '../../../models/ZoneModel.js';
import os from 'os';

/**
 * Execute zone discovery task
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDiscoverTask = async () => {
  try {
    // Get all zones from system using zadm
    const systemZones = await getAllZoneConfigs();
    const systemZoneNames = Object.keys(systemZones);

    // Get all zones from database
    const dbZones = await Zones.findAll();
    const dbZoneNames = dbZones.map(z => z.name);

    let discovered = 0;
    let orphaned = 0;

    // Add new zones found on system but not in database
    const newZonesToCreate = systemZoneNames.filter(zoneName => !dbZoneNames.includes(zoneName));

    const createdZones = await Promise.all(
      newZonesToCreate.map(async zoneName => {
        const zoneConfig = systemZones[zoneName];

        // Get current status
        const statusResult = await executeCommand(`pfexec zoneadm -z ${zoneName} list -p`);
        let status = 'configured';
        if (statusResult.success) {
          const parts = statusResult.output.split(':');
          status = parts[2] || 'configured';
        }

        return Zones.create({
          name: zoneName,
          zone_id: zoneConfig.zonename || zoneName,
          host: os.hostname(),
          status,
          brand: zoneConfig.brand || 'unknown',
          configuration: zoneConfig,
          auto_discovered: true,
          last_seen: new Date(),
        });
      })
    );

    discovered = createdZones.length;

    // Process orphaned and existing zones in parallel
    const orphanedZones = dbZones.filter(dbZone => !systemZoneNames.includes(dbZone.name));
    const existingZones = dbZones.filter(dbZone => systemZoneNames.includes(dbZone.name));

    // Mark zones as orphaned in parallel
    await Promise.all(orphanedZones.map(dbZone => dbZone.update({ is_orphaned: true })));
    orphaned = orphanedZones.length;

    // Update existing zones in parallel
    await Promise.all(
      existingZones.map(async dbZone => {
        const zoneConfig = systemZones[dbZone.name];
        const statusResult = await executeCommand(`pfexec zoneadm -z ${dbZone.name} list -p`);
        let { status } = dbZone;
        if (statusResult.success) {
          const parts = statusResult.output.split(':');
          status = parts[2] || dbZone.status;
        }

        // Preserve user-defined config sections (settings, zones, networks, disks, provisioner)
        preserveUserConfig(dbZone, zoneConfig, dbZone.name);

        return dbZone.update({
          status,
          brand: zoneConfig.brand || dbZone.brand,
          configuration: zoneConfig,
          last_seen: new Date(),
          is_orphaned: false,
        });
      })
    );

    return {
      success: true,
      message: `Discovery completed: ${discovered} new zones discovered, ${orphaned} zones orphaned`,
    };
  } catch (error) {
    return {
      success: false,
      error: `Zone discovery failed: ${error.message}`,
    };
  }
};
