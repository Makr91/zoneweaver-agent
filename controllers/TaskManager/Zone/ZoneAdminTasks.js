/**
 * @fileoverview Zone administration task executors (zone_attach / zone_detach / zone_move)
 * @description The queued halves of the surveyed zoneadm verbs — each runs
 * the native command and refreshes the machine's stored record afterwards so
 * status and zonepath stay honest.
 */

import { executeCommand } from '../../../lib/CommandManager.js';
import { syncZoneToDatabase } from '../../../lib/ZoneConfigUtils.js';
import { log } from '../../../lib/Logger.js';

const parseMetadata = metadataJson => {
  if (!metadataJson) {
    return {};
  }
  try {
    return JSON.parse(metadataJson) || {};
  } catch {
    return {};
  }
};

const runZoneadm = async (zoneName, args, operation, timeoutMs) => {
  const result = await executeCommand(`pfexec zoneadm -z ${zoneName} ${args}`, timeoutMs);
  if (!result.success) {
    log.task.error(`${operation} failed`, { zone_name: zoneName, error: result.error });
    return { success: false, error: `${operation} failed: ${result.error}` };
  }
  await syncZoneToDatabase(zoneName);
  return { success: true, message: `${operation} completed` };
};

export const executeZoneDetachTask = zoneName => runZoneadm(zoneName, 'detach', 'zone_detach');

export const executeZoneAttachTask = (zoneName, metadataJson) => {
  const { update, force } = parseMetadata(metadataJson);
  const flags = [update === true ? '-u' : null, force === true ? '-F' : null]
    .filter(Boolean)
    .join(' ');
  return runZoneadm(zoneName, flags ? `attach ${flags}` : 'attach', 'zone_attach', 600000);
};

export const executeZoneMoveTask = (zoneName, metadataJson) => {
  const { target_path } = parseMetadata(metadataJson);
  if (typeof target_path !== 'string' || !target_path.startsWith('/')) {
    return Promise.resolve({
      success: false,
      error: 'zone_move metadata carries no absolute target_path',
    });
  }
  return runZoneadm(zoneName, `move ${target_path}`, 'zone_move', 3600000);
};
