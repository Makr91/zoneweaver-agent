/**
 * @fileoverview Zone Modify Orchestrator for Zone Configuration Changes
 * @description Coordinates zone modification tasks — parses metadata, dispatches attribute,
 * network, storage, cloud-init, and provisioning changes, and finalizes the database sync.
 * Changes are queued and take effect on next zone boot
 */

import yj from 'yieldable-json';
import { log } from '../../../lib/Logger.js';
import { getZoneConfig, syncZoneToDatabase } from '../../../lib/ZoneConfigUtils.js';
import { clearPendingChanges } from '../../../lib/ZoneConfigMutators.js';
import { updateTaskProgress } from '../../../lib/TaskProgressHelper.js';
import {
  applyAttributeChangesIfNeeded,
  applyAutobootChange,
  applyCloudInitChanges,
} from './ZoneAttributeModifier.js';
import { handleNetworkModifications } from './ZoneNetworkModifier.js';
import { handleStorageModifications } from './ZoneStorageModifier.js';
import { applyResourceControlChanges } from './ZoneResourceControlModifier.js';

/**
 * Parse modification metadata
 * @param {Object} task - Task object
 * @returns {Promise<{metadata: Object, zoneName: string, zoneConfig: Object}>}
 */
const parseModificationMetadata = async task => {
  await updateTaskProgress(task, 5, { status: 'parsing_metadata' });

  const metadata = await new Promise((resolve, reject) => {
    yj.parseAsync(task.metadata, (err, parsed) => (err ? reject(err) : resolve(parsed)));
  });

  const zoneName = task.zone_name;

  await updateTaskProgress(task, 10, { status: 'reading_configuration' });
  const zoneConfig = await getZoneConfig(zoneName);

  return { metadata, zoneName, zoneConfig };
};

/**
 * Finalize modification and update database
 * @param {string} zoneName - Zone name
 * @param {Object} task - Task object
 * @param {Array} changes - Array of changes made
 * @returns {Promise<void>}
 */
const finalizeModification = async (zoneName, task, changes) => {
  await updateTaskProgress(task, 95, { status: 'updating_database_configuration' });
  await syncZoneToDatabase(zoneName);

  await updateTaskProgress(task, 100, { status: 'completed', changes });

  log.task.info('Zone modification completed', {
    zone_name: zoneName,
    changes,
  });
};

/**
 * Execute zone modification task
 * @param {Object} task - Task object from database
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneModifyTask = async task => {
  log.task.debug('Zone modification task starting', {
    task_id: task.id,
    zone_name: task.zone_name,
  });

  try {
    const { metadata, zoneName, zoneConfig } = await parseModificationMetadata(task);
    const { onData } = task;

    const changes = [];

    const initialChanges = changes.length;
    await applyAttributeChangesIfNeeded(zoneName, zoneConfig, metadata, task, changes, onData);
    if (changes.length > initialChanges) {
      await syncZoneToDatabase(zoneName);
    }

    if (metadata.autoboot !== undefined) {
      await updateTaskProgress(task, 40, { status: 'modifying_autoboot' });
      await applyAutobootChange(zoneName, metadata.autoboot, onData);
      changes.push('autoboot');
      await syncZoneToDatabase(zoneName);
    }

    const beforeResourceControls = changes.length;
    await applyResourceControlChanges(zoneName, zoneConfig, metadata, task, changes, onData);
    if (changes.length > beforeResourceControls) {
      await syncZoneToDatabase(zoneName);
    }

    await handleNetworkModifications(zoneName, metadata, task, changes, onData);
    await handleStorageModifications(zoneName, zoneConfig, metadata, task, changes, onData);

    if (metadata.cloud_init) {
      await updateTaskProgress(task, 85, { status: 'modifying_cloud_init' });
      await applyCloudInitChanges(zoneName, zoneConfig, metadata.cloud_init, onData);
      changes.push('cloud_init');
      await syncZoneToDatabase(zoneName);
    }

    await finalizeModification(zoneName, task, changes);

    // Accrued pending changes (the _apply_pending marker) clear on success —
    // a failed apply keeps them pending for the next power cycle.
    if (metadata._apply_pending === true) {
      try {
        await clearPendingChanges(zoneName);
      } catch (clearError) {
        log.task.warn('Pending-changes clear failed (they will re-apply next cycle)', {
          zone_name: zoneName,
          error: clearError.message,
        });
      }
    }

    return {
      success: true,
      message: `Zone ${zoneName} modified successfully (${changes.join(', ')}). Changes will take effect on next zone boot.`,
    };
  } catch (error) {
    log.task.error('Zone modification task exception', {
      error: error.message,
      stack: error.stack,
      zone_name: task.zone_name,
    });

    return {
      success: false,
      error: `Zone modification failed: ${error.message}`,
    };
  }
};
