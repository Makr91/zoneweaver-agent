import { parseAsync } from '../../../../lib/AsyncJson.js';
import { executeCommand } from '../../../../lib/CommandManager.js';
import { log } from '../../../../lib/Logger.js';

/**
 * @fileoverview ZFS volume usage checking utilities
 */

/**
 * Check if a zvol is already in use by another zone
 * @param {string} zvolPath - ZFS volume path to check
 * @param {string} [excludeZone] - Zone name to exclude from check
 * @returns {Promise<{inUse: boolean, usedBy: string|null}>}
 */
export const checkZvolInUse = async (zvolPath, excludeZone = null) => {
  const result = await executeCommand('pfexec zadm show');
  if (!result.success) {
    log.task.warn('Could not check zvol usage - zadm show failed', { error: result.error });
    return { inUse: false, usedBy: null };
  }

  let allZones;
  try {
    allZones = await parseAsync(result.output);
  } catch {
    log.task.warn('Could not parse zone configs for zvol check');
    return { inUse: false, usedBy: null };
  }

  for (const [zoneName, zoneConfig] of Object.entries(allZones)) {
    if (excludeZone && zoneName === excludeZone) {
      continue;
    }

    // Check bootdisk (object form from zadm show)
    if (zoneConfig.bootdisk?.path === zvolPath) {
      return { inUse: true, usedBy: zoneName };
    }

    // Check attrs for bootdisk and numbered disks
    if (Array.isArray(zoneConfig.attr)) {
      for (const attr of zoneConfig.attr) {
        if ((attr.name === 'bootdisk' || /^disk\d*$/u.test(attr.name)) && attr.value === zvolPath) {
          return { inUse: true, usedBy: zoneName };
        }
      }
    }
  }

  return { inUse: false, usedBy: null };
};
