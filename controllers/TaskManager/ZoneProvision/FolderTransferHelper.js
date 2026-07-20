import { executeSSHCommand, syncFiles, scpSyncFiles } from '../../../lib/SSHManager.js';
import { log } from '../../../lib/Logger.js';

/**
 * Narrate the scp transport's option downgrade (args/exclude/delete have no
 * scp equivalents) — shared by the push and pull paths.
 */
export const narrateScpDowngrade = (folder, onData) => {
  if (folder.args || folder.exclude || folder.delete) {
    onData?.({
      stream: 'stdout',
      data: 'scp transport: args/exclude/delete have no scp equivalents — ignored\n',
    });
  }
};

/**
 * Run one folder's transfer over its configured transport: scp copies the
 * tree verbatim (options narrated as ignored); everything else rides rsync
 * with its full options.
 */
export const runFolderTransfer = (transfer, folder, onData) => {
  const { ip, username, credentials, resolvedSource, dest, port, provisioningBasePath } = transfer;
  if ((folder.type || '').toLowerCase() === 'scp') {
    narrateScpDowngrade(folder, onData);
    return scpSyncFiles(ip, username, credentials, resolvedSource, dest, port, {
      provisioningBasePath,
      onData,
    });
  }
  return syncFiles(ip, username, credentials, resolvedSource, dest, port, {
    exclude: folder.exclude,
    args: folder.args,
    delete: folder.delete,
    provisioningBasePath,
    onData,
  });
};

/**
 * Chown synced files to the folder's owner (matching vagrant-zones behavior);
 * a failure is narrated, never fatal.
 */
export const applySyncOwnership = async (transfer, folder, zoneName, onData) => {
  const { ip, username, credentials, dest, port, provisioningBasePath } = transfer;
  const syncOwner = folder.owner || username;
  const syncGroup = folder.group || syncOwner;
  const chownResult = await executeSSHCommand(
    ip,
    username,
    credentials,
    `sudo chown -R ${syncOwner}:${syncGroup} ${dest}`,
    port,
    { provisioningBasePath, onData }
  );
  if (!chownResult.success) {
    log.task.warn('Failed to set ownership on synced files', {
      zone_name: zoneName,
      dest,
      owner: syncOwner,
      error: chownResult.stderr,
    });
  }
};
