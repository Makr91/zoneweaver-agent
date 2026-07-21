/**
 * @fileoverview Zone folder sync and syncback task executors for Zoneweaver Agent
 * @description Granular per-folder push (host → zone) and pull (zone → host) provisioning transfers.
 */

import { log } from '../../lib/Logger.js';
import {
  executeSSHCommand,
  syncFilesFromZone,
  scpSyncFilesFromZone,
} from '../../lib/SSHManager.js';
import { updateTaskProgress, parseTaskMetadata } from '../../lib/TaskProgressHelper.js';
import {
  getProvisioningBasePath,
  readDocumentControlIP,
  NO_CONTROL_IP_ERROR,
} from './ZoneEngineManager.js';
import {
  narrateScpDowngrade,
  runFolderTransfer,
  applySyncOwnership,
} from './ZoneProvision/FolderTransferHelper.js';

/**
 * Execute zone file sync task (GRANULAR: handles ONE folder)
 * Syncs a single provisioning folder from host to zone via rsync
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneSyncTask = async task => {
  const { zone_name } = task;

  try {
    const metadata = await parseTaskMetadata(task);

    const { port = 22, credentials = {}, folder } = metadata;
    const { onData } = task;

    if (!folder) {
      return { success: false, error: 'folder is required in task metadata' };
    }
    // The chain may predate the provisioning lease — the document is the truth.
    const ip = metadata.ip || (await readDocumentControlIP(zone_name));
    if (!ip) {
      return { success: false, error: NO_CONTROL_IP_ERROR };
    }

    const { map, to, disabled = false } = folder;
    const source = map || folder.source;
    const dest = to || folder.dest;

    if (disabled || (folder.type || '').toLowerCase() === 'virtualbox') {
      return {
        success: true,
        message: `Folder sync skipped (${disabled ? 'disabled' : 'virtualbox shared folders are never used'})`,
      };
    }

    if (!source || !dest) {
      return { success: false, error: 'Folder missing source (map) or destination (to)' };
    }

    const provisioningBasePath = await getProvisioningBasePath(zone_name);
    const resolvedSource = source.startsWith('/') ? source : `${provisioningBasePath}/${source}`;
    const transfer = {
      ip,
      port,
      credentials,
      username: credentials.username || 'root',
      resolvedSource,
      dest,
      provisioningBasePath,
    };

    log.task.info('Syncing folder to zone', { zone_name, source: resolvedSource, dest });

    // Pre-create destination directory
    await updateTaskProgress(task, 10, { status: 'creating_destination' });
    await executeSSHCommand(ip, transfer.username, credentials, `sudo mkdir -p ${dest}`, port, {
      provisioningBasePath,
      onData,
    });

    await updateTaskProgress(task, 30, { status: 'syncing_files' });
    const result = await runFolderTransfer(transfer, folder, onData);
    if (!result.success) {
      return { success: false, error: `${source} → ${dest}: ${result.error}` };
    }

    await updateTaskProgress(task, 85, { status: 'setting_ownership' });
    await applySyncOwnership(transfer, folder, zone_name, onData);

    return {
      success: true,
      message: `Synced folder: ${source} → ${dest}`,
    };
  } catch (error) {
    log.task.error('Zone file sync failed', { zone_name, error: error.message });
    return { success: false, error: `File sync failed: ${error.message}` };
  }
};

/**
 * Execute zone syncback task (GRANULAR: handles ONE flagged folder).
 * The push reversed — guest folder.to pulls back to host folder.map
 * (shared semantics with the Go agent's machine_syncback): folder.delete is
 * never honored on pull, pulled files stay agent-owned (no chown),
 * args/exclude ride the rsync path; scp pulls read as the SSH user.
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneSyncbackTask = async task => {
  const { zone_name } = task;

  try {
    const metadata = await parseTaskMetadata(task);

    const { port = 22, credentials = {}, folder } = metadata;
    const { onData } = task;

    if (!folder) {
      return { success: false, error: 'folder is required in task metadata' };
    }
    // The chain may predate the provisioning lease — the document is the truth.
    const ip = metadata.ip || (await readDocumentControlIP(zone_name));
    if (!ip) {
      return { success: false, error: NO_CONTROL_IP_ERROR };
    }

    const source = folder.to || folder.dest;
    const dest = folder.map || folder.source;
    if (!source || !dest) {
      return { success: false, error: 'Folder missing source (to) or destination (map)' };
    }

    const provisioningBasePath = await getProvisioningBasePath(zone_name);
    const resolvedDest = dest.startsWith('/') ? dest : `${provisioningBasePath}/${dest}`;
    const username = credentials.username || 'root';

    log.task.info('Pulling folder from zone (syncback)', {
      zone_name,
      source,
      dest: resolvedDest,
    });

    await updateTaskProgress(task, 30, { status: 'pulling_files' });
    let result;
    if ((folder.type || '').toLowerCase() === 'scp') {
      narrateScpDowngrade(folder, onData);
      onData?.({
        stream: 'stdout',
        data: 'scp pull reads as the SSH user — root-only guest files are skipped\n',
      });
      result = await scpSyncFilesFromZone(ip, username, credentials, source, resolvedDest, port, {
        provisioningBasePath,
        onData,
      });
    } else {
      if (folder.delete) {
        onData?.({
          stream: 'stdout',
          data: 'folder.delete is never honored on syncback — ignored\n',
        });
      }
      result = await syncFilesFromZone(ip, username, credentials, source, resolvedDest, port, {
        exclude: folder.exclude,
        args: folder.args,
        provisioningBasePath,
        onData,
      });
    }
    if (!result.success) {
      return { success: false, error: `${source} → ${resolvedDest}: ${result.error}` };
    }

    return {
      success: true,
      message: `Pulled folder: ${source} → ${resolvedDest}`,
    };
  } catch (error) {
    log.task.error('Zone syncback failed', { zone_name, error: error.message });
    return { success: false, error: `Syncback failed: ${error.message}` };
  }
};
