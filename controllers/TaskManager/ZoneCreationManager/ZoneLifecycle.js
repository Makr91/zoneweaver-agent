import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';

/**
 * @fileoverview Zone lifecycle operations - rollback and configuration storage
 */

/**
 * Rollback zone creation on failure
 * @param {string} zoneName - Zone name
 * @param {boolean} zonecfgApplied - Whether zonecfg was applied
 * @param {Array} zfsCreated - Array of created ZFS datasets to destroy
 */
export const rollbackCreation = async (zoneName, zonecfgApplied, zfsCreated) => {
  if (!zoneName) {
    return;
  }

  try {
    if (zonecfgApplied) {
      await executeCommand(`pfexec zonecfg -z ${zoneName} delete -F`);
      log.task.info('Rolled back zone configuration', { zone_name: zoneName });
    }

    const destroyPromises = [...zfsCreated]
      .reverse()
      .map(dataset =>
        executeCommand(`pfexec zfs destroy -r ${dataset}`).then(() =>
          log.task.info('Rolled back ZFS dataset', { dataset })
        )
      );
    await Promise.all(destroyPromises);
  } catch (rollbackError) {
    log.task.error('Rollback failed', { error: rollbackError.message });
  }
};

/**
 * Store infrastructure configuration in zone record
 * @param {Object} zone - Zone database record
 * @param {Object} metadata - Zone creation metadata
 * @param {string} zoneName - Zone name
 */
export const storeInfrastructureConfig = async (zone, metadata, zoneName) => {
  // The JSON column hands back the row's LIVE object — mutating it in place
  // makes Sequelize's change detection compare the object to itself and SKIP
  // the write (the saveConfiguration bug: the document silently never stored,
  // so stage/provision/detail all read an empty document). Mutate a detached
  // clone and mark the column changed explicitly.
  let zoneConfig = zone.configuration || {};
  if (typeof zoneConfig === 'string') {
    try {
      zoneConfig = JSON.parse(zoneConfig);
    } catch (e) {
      log.task.warn('Failed to parse zone configuration for storage', { error: e.message });
      zoneConfig = {};
    }
  }
  zoneConfig = structuredClone(zoneConfig);

  // Store Hosts.yml infrastructure sections if present
  if (metadata.settings) {
    zoneConfig.settings = metadata.settings;
  }
  if (metadata.zones) {
    zoneConfig.zones = metadata.zones;
  }
  if (metadata.networks) {
    zoneConfig.networks = metadata.networks;
  }
  if (metadata.disks) {
    zoneConfig.disks = metadata.disks;
  }
  if (metadata.provisioner) {
    zoneConfig.provisioner = metadata.provisioner;
  }
  if (metadata.provisioner_ref) {
    zoneConfig.provisioner_ref = metadata.provisioner_ref;
  }
  if (metadata.snapshots) {
    zoneConfig.snapshots = metadata.snapshots;
  }
  if (metadata.metadata) {
    zoneConfig.metadata = metadata.metadata;
  }

  zone.set('configuration', zoneConfig);
  zone.changed('configuration', true);
  await zone.save();
  log.task.info('Stored infrastructure configuration in zone record', {
    zone_name: zoneName,
    has_settings: !!metadata.settings,
    has_zones: !!metadata.zones,
    has_networks: !!metadata.networks,
    has_disks: !!metadata.disks,
    has_provisioner: !!metadata.provisioner,
  });
};
