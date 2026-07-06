/**
 * @fileoverview Zone ZFS Dataset Cleanup Helpers for Zoneweaver Agent
 * @description Collects, verifies, and safely destroys ZFS datasets belonging to a zone
 * during deletion, protecting datasets used by other zones.
 */
import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import { getAllZoneConfigs, syncZoneToDatabase } from '../../../lib/ZoneConfigUtils.js';
import Zones from '../../../models/ZoneModel.js';

/**
 * Fetches and parses the zone configuration, with a self-healing fallback.
 * @param {string} zoneName - The name of the zone.
 * @returns {Promise<Object|null>} The parsed zone configuration or null on failure.
 */
const getZoneConfigurationForCleanup = async zoneName => {
  try {
    const zone = await Zones.findOne({ where: { name: zoneName } });
    let zoneConfig = zone?.configuration;

    if (typeof zoneConfig === 'string') {
      try {
        zoneConfig = JSON.parse(zoneConfig);
      } catch (parseErr) {
        log.task.error('Failed to parse zone configuration string', {
          zone_name: zoneName,
          error: parseErr.message,
        });
        return null; // Unusable config
      }
    }

    if (!zoneConfig) {
      log.task.info('Zone not found in DB, attempting to sync from system for cleanup', {
        zone_name: zoneName,
      });
      const newZone = await syncZoneToDatabase(zoneName);
      zoneConfig = newZone.configuration;
    }
    return zoneConfig;
  } catch (error) {
    log.task.warn('Could not get zone configuration for cleanup', {
      zone_name: zoneName,
      error: error.message,
    });
    return null;
  }
};

/**
 * Helper to collect datasets from zonepath
 * @param {Object} zoneConfig - Zone configuration
 * @param {Set<string>} potentialDatasets - Set to add datasets to
 */
const collectZonepathDatasets = (zoneConfig, potentialDatasets) => {
  if (zoneConfig.zonepath) {
    let candidateDataset = zoneConfig.zonepath.startsWith('/')
      ? zoneConfig.zonepath.substring(1)
      : zoneConfig.zonepath;
    if (candidateDataset.endsWith('/path')) {
      candidateDataset = candidateDataset.substring(0, candidateDataset.length - 5);
    }
    potentialDatasets.add(candidateDataset);
  }
};

/**
 * Helper to collect datasets from bootdisk
 * @param {Object} zoneConfig - Zone configuration
 * @param {Set<string>} potentialDatasets - Set to add datasets to
 */
const collectBootdiskDatasets = (zoneConfig, potentialDatasets) => {
  if (zoneConfig.bootdisk?.path) {
    potentialDatasets.add(zoneConfig.bootdisk.path);
    const parts = zoneConfig.bootdisk.path.split('/');
    if (parts.length > 1) {
      potentialDatasets.add(parts.slice(0, -1).join('/'));
    }
  }
};

/**
 * Helper to collect datasets from disks and legacy attributes
 * @param {Object} zoneConfig - Zone configuration
 * @param {Set<string>} potentialDatasets - Set to add datasets to
 */
const collectDiskDatasets = (zoneConfig, potentialDatasets) => {
  // Additional Disks
  if (zoneConfig.disk) {
    const disks = Array.isArray(zoneConfig.disk) ? zoneConfig.disk : [zoneConfig.disk];
    for (const disk of disks) {
      if (disk.path) {
        potentialDatasets.add(disk.path);
      }
    }
  }

  // Legacy disk attributes
  if (zoneConfig.attr) {
    const attrs = Array.isArray(zoneConfig.attr) ? zoneConfig.attr : [zoneConfig.attr];
    for (const attr of attrs) {
      if (attr.name && /^disk\d+$/.test(attr.name) && attr.value) {
        potentialDatasets.add(attr.value);
      }
    }
  }
};

/**
 * Helper to collect datasets from devices, filesystems, and explicit datasets
 * @param {Object} zoneConfig - Zone configuration
 * @param {Set<string>} potentialDatasets - Set to add datasets to
 */
const collectMiscDatasets = (zoneConfig, potentialDatasets) => {
  // ZVOL devices
  if (zoneConfig.device) {
    const devices = Array.isArray(zoneConfig.device) ? zoneConfig.device : [zoneConfig.device];
    for (const dev of devices) {
      if (dev.match) {
        const match = dev.match.match(/\/dev\/zvol\/(?:r)?dsk\/(?<dataset>.+)/);
        if (match?.groups?.dataset) {
          potentialDatasets.add(match.groups.dataset);
        }
      }
    }
  }

  // Filesystems
  if (zoneConfig.fs) {
    const fss = Array.isArray(zoneConfig.fs) ? zoneConfig.fs : [zoneConfig.fs];
    for (const fs of fss) {
      if (fs.special) {
        if (!fs.special.startsWith('/')) {
          potentialDatasets.add(fs.special);
        } else {
          const match = fs.special.match(/\/dev\/zvol\/(?:r)?dsk\/(?<dataset>.+)/);
          if (match?.groups?.dataset) {
            potentialDatasets.add(match.groups.dataset);
          }
        }
      }
    }
  }

  // Explicit datasets
  if (zoneConfig.dataset) {
    const dss = Array.isArray(zoneConfig.dataset) ? zoneConfig.dataset : [zoneConfig.dataset];
    for (const ds of dss) {
      if (ds.name) {
        potentialDatasets.add(ds.name);
      }
    }
  }
};

/**
 * Collects all potential ZFS dataset paths from a zone's configuration.
 * @param {Object} zoneConfig - The parsed zone configuration.
 * @returns {Set<string>} A set of potential dataset paths.
 */
const collectPotentialDatasets = zoneConfig => {
  const potentialDatasets = new Set();
  collectZonepathDatasets(zoneConfig, potentialDatasets);
  collectBootdiskDatasets(zoneConfig, potentialDatasets);
  collectDiskDatasets(zoneConfig, potentialDatasets);
  collectMiscDatasets(zoneConfig, potentialDatasets);
  return potentialDatasets;
};

/**
 * Verifies the existence of potential datasets in parallel.
 * @param {Set<string>} potentialDatasets - A set of dataset names to verify.
 * @returns {Promise<string[]>} An array of dataset names that exist on the system.
 */
const verifyDatasets = async potentialDatasets => {
  const verificationPromises = Array.from(potentialDatasets).map(async ds => {
    try {
      // Suppress error logging for non-existent datasets using shell redirection
      const result = await executeCommand(`pfexec zfs list -H -o name "${ds}" 2>/dev/null || true`);
      if (result.success && result.output.trim()) {
        return result.output.trim();
      }
      return null;
    } catch (error) {
      log.task.debug('Dataset verification failed for potential dataset', {
        dataset: ds,
        error: error.message,
      });
      return null;
    }
  });

  const verified = await Promise.all(verificationPromises);
  return verified.filter(Boolean); // Filter out nulls
};

/**
 * Extract ZFS dataset paths from a zone configuration for cleanup
 * @param {string} zoneName - Name of zone
 * @returns {Promise<{zonepath: string|null, datasets: string[]}>}
 */
export const extractZoneDatasets = async zoneName => {
  try {
    const zoneConfig = await getZoneConfigurationForCleanup(zoneName);

    if (!zoneConfig) {
      return { zonepath: null, datasets: [] };
    }

    const potentialDatasets = collectPotentialDatasets(zoneConfig);
    const datasets = await verifyDatasets(potentialDatasets);

    return { zonepath: zoneConfig.zonepath, datasets };
  } catch (error) {
    log.task.warn('Failed to extract zone datasets', {
      zone_name: zoneName,
      error: error.message,
    });
    return { zonepath: null, datasets: [] };
  }
};

/**
 * Get a set of datasets that are protected (used by other zones)
 * @param {string} excludeZoneName - The name of the zone being deleted
 * @returns {Promise<Set<string>>} Set of protected dataset paths
 */
const getProtectedDatasets = async excludeZoneName => {
  const protectedDatasets = new Set();
  try {
    const allZones = await getAllZoneConfigs();

    for (const [zoneName, config] of Object.entries(allZones)) {
      if (zoneName === excludeZoneName) {
        continue;
      }

      // Protect zonepath (and normalized dataset name)
      if (config.zonepath) {
        protectedDatasets.add(config.zonepath);
        // Normalize to dataset name (strip leading / and trailing /path)
        let dsName = config.zonepath.startsWith('/')
          ? config.zonepath.substring(1)
          : config.zonepath;
        if (dsName.endsWith('/path')) {
          dsName = dsName.substring(0, dsName.length - 5);
        }
        protectedDatasets.add(dsName);
      }

      // Protect bootdisk
      if (config.bootdisk?.path) {
        protectedDatasets.add(config.bootdisk.path);
      }

      // Protect disks
      if (config.disk) {
        const disks = Array.isArray(config.disk) ? config.disk : [config.disk];
        for (const disk of disks) {
          if (disk.path) {
            protectedDatasets.add(disk.path);
          }
        }
      }
      // Note: Legacy 'attr' disks are covered if they appear in 'disk' array (zadm handles this),
      // but we could add specific attr parsing if needed. zadm show usually normalizes this.
    }
  } catch (error) {
    log.task.warn('Failed to build protected datasets list', { error: error.message });
  }
  return protectedDatasets;
};

/**
 * Process single dataset for deletion with safety checks
 * @param {string} dataset - Dataset to destroy
 * @param {string} zoneName - Zone name
 * @param {Set} protectedDatasets - Protected datasets (Set)
 * @returns {Promise<string|null>} Error message or null if successful
 */
const processSingleDataset = async (dataset, zoneName, protectedDatasets) => {
  // Safety Check: Intersection with protected datasets
  const isProtected = Array.from(protectedDatasets).some(
    protectedDs =>
      dataset === protectedDs ||
      protectedDs.startsWith(`${dataset}/`) ||
      protectedDs.startsWith(`/${dataset}/`)
  );

  if (isProtected) {
    log.task.warn('Skipping protected dataset', { zone_name: zoneName, dataset });
    return null;
  }

  // Execute Safe Destroy
  const check = await executeCommand(`pfexec zfs list -H -o name "${dataset}" 2>/dev/null`);
  if (check.success) {
    const destroyResult = await executeCommand(`pfexec zfs destroy -r "${dataset}"`);
    if (!destroyResult.success) {
      return `Failed to destroy ${dataset}: ${destroyResult.error}`;
    }
    log.task.info('Destroyed ZFS dataset', { dataset });
  }
  return null;
};

/**
 * Clean up ZFS datasets for a zone
 * @param {string} zoneName - Name of the zone
 * @param {Object} zoneDatasets - Datasets to clean up
 * @returns {Promise<string[]>} Array of error messages
 */
export const cleanupZoneDatasets = async (zoneName, zoneDatasets) => {
  const protectedDatasets = await getProtectedDatasets(zoneName);
  const sortedDatasets = [...zoneDatasets.datasets].sort((a, b) => a.length - b.length);

  const errors = await Promise.all(
    sortedDatasets.map(dataset => processSingleDataset(dataset, zoneName, protectedDatasets))
  );

  return errors.filter(Boolean);
};
