import { executeCommand } from '../../../lib/CommandManager.js';
import { syncZoneToDatabase } from '../../../lib/ZoneConfigUtils.js';
import Zones from '../../../models/ZoneModel.js';
import { log } from '../../../lib/Logger.js';
import { buildDatasetPath } from './utils/ConfigBuilders.js';
import { updateTaskProgress } from '../../../lib/TaskProgressHelper.js';

/**
 * @fileoverview Zone lifecycle operations - validation, rollback, finalization
 */

/**
 * Validate zone creation request
 * Supports both old structure (metadata.brand) and new Hosts.yml structure (metadata.zones.brand)
 * @param {Object} metadata - Parsed metadata
 * @param {string} zoneName - Zone name
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
export const validateZoneCreationRequest = async (metadata, zoneName) => {
  const brand = metadata.zones?.brand || metadata.brand;

  if (!zoneName || !brand) {
    return {
      valid: false,
      error: 'Missing required parameters: name and brand are required',
    };
  }

  const existCheck = await executeCommand(`pfexec zoneadm -z ${zoneName} list -p`);
  if (existCheck.success) {
    return { valid: false, error: `Zone ${zoneName} already exists on the system` };
  }

  return { valid: true };
};

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
  let zoneConfig = zone.configuration || {};
  if (typeof zoneConfig === 'string') {
    try {
      zoneConfig = JSON.parse(zoneConfig);
    } catch (e) {
      log.task.warn('Failed to parse zone configuration for storage', { error: e.message });
      zoneConfig = {};
    }
  }

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
  if (metadata.metadata) {
    zoneConfig.metadata = metadata.metadata;
  }

  await zone.update({ configuration: zoneConfig });
  log.task.info('Stored infrastructure configuration in zone record', {
    zone_name: zoneName,
    has_settings: !!metadata.settings,
    has_zones: !!metadata.zones,
    has_networks: !!metadata.networks,
    has_disks: !!metadata.disks,
  });
};

/**
 * Sync zone to database and persist server_id/vm_type, then install
 * @param {string} zoneName - Zone name
 * @param {Object} metadata - Zone creation metadata
 * @param {Object} task - Task object for progress updates
 */
export const finalizeAndInstallZone = async (zoneName, metadata, task, onData = null) => {
  await syncZoneToDatabase(zoneName, 'configured');

  const zoneRecord = await Zones.findOne({ where: { name: zoneName } });
  if (zoneRecord) {
    await zoneRecord.update({
      server_id: metadata.server_id,
      vm_type: metadata.zones?.vmtype || metadata.vm_type || 'production',
    });
  }

  await updateTaskProgress(task, 90, { status: 'installing_zone' });
  const installResult = await executeCommand(
    `pfexec zoneadm -z ${zoneName} install`,
    3600 * 1000,
    onData
  );
  if (!installResult.success) {
    throw new Error(`Zone installation failed: ${installResult.error}`);
  }

  // Fix zonepath permissions for service user (zwagent) access to provisioning datasets
  const pool = metadata.disks?.boot?.pool || 'rpool';
  const dataset = metadata.disks?.boot?.dataset || 'zones';
  const datasetPath = buildDatasetPath(`${pool}/${dataset}`, zoneName, metadata.server_id);
  const zonepath = metadata.zonepath || `/${datasetPath}/path`;
  const chmodResult = await executeCommand(`pfexec chmod 755 ${zonepath}`);
  if (!chmodResult.success) {
    log.task.warn('Failed to set zonepath permissions', { zonepath, error: chmodResult.error });
  }

  await updateTaskProgress(task, 97, { status: 'creating_database_record' });
  await syncZoneToDatabase(zoneName, 'installed');

  // Store infrastructure sections in zone.configuration (Hosts.yml structure)
  await updateTaskProgress(task, 98, { status: 'storing_configuration' });
  const zone = await Zones.findOne({ where: { name: zoneName } });
  if (zone) {
    await storeInfrastructureConfig(zone, metadata, zoneName);
  }
};
