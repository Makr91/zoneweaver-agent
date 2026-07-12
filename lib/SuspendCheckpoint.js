import path from 'path';
import { executeCommand } from './CommandManager.js';

/**
 * @fileoverview Suspend checkpoint locations and probes
 * @description The suspend verb checkpoints a running bhyve machine via
 * `bhyvectl --suspend=<statefile>`; resume boots with `-r <statefile>` wired
 * into the zone's `extra` attr. The checkpoint lives INSIDE the zonepath so it
 * dies with the zone's datasets, and its existence — not the DB status — is
 * the truth "this machine can resume" (discovery preserves the suspended
 * status only while the file exists).
 */

/**
 * The statefile bhyvectl writes for this zone (zonepath-adjacent).
 * @param {string} zonepath - Zone's zonepath
 * @returns {string} Checkpoint file path
 */
export const suspendCheckpointPath = zonepath => path.join(zonepath, 'suspend.ckp');

/**
 * Whether the zone has a suspend checkpoint. Probes through pfexec — the
 * zonepath is root-owned and unreadable to the agent process itself.
 * @param {string} zonepath - Zone's zonepath
 * @returns {Promise<boolean>}
 */
export const hasSuspendCheckpoint = async zonepath => {
  if (!zonepath) {
    return false;
  }
  const result = await executeCommand(`pfexec ls ${suspendCheckpointPath(zonepath)}`);
  return result.success;
};

/**
 * Delete the zone's suspend checkpoint (plus any sidecar files the platform
 * writes next to it — the glob covers both).
 * @param {string} zonepath - Zone's zonepath
 * @returns {Promise<{success: boolean}>}
 */
export const deleteSuspendCheckpoint = zonepath =>
  executeCommand(`pfexec rm -f ${suspendCheckpointPath(zonepath)}*`);
