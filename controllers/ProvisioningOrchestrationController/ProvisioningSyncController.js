/**
 * @fileoverview Ad-hoc zone file sync endpoint
 */

import Zones from '../../models/ZoneModel.js';
import { log } from '../../lib/Logger.js';
import { extractFolders } from '../../lib/ProvisionerConfigBuilder.js';
import { validateProvisioningRequest } from './utils/ValidationHelper.js';
import { resolveCommunicatorSettings } from './utils/TaskChainBuilder.js';
import {
  createTask,
  createSequentialTransferTasks,
  syncbackEligibleFolders,
} from './utils/TaskCreationHelper.js';

/**
 * @swagger
 * /machines/{name}/sync:
 *   post:
 *     summary: Sync machine files ad-hoc
 *     description: |
 *       Creates a zone_sync task chain to sync provisioning files to the
 *       machine (host → guest, all folders). Body {"syncback": true} reverses
 *       it: ONLY folders flagged syncback: true pull back guest → host
 *       (folder.to → folder.map; delete never honored, files stay
 *       agent-owned). Independent of the full provisioning pipeline; callable
 *       anytime after SSH is accessible.
 *     tags: [Provisioning Tasks]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               syncback:
 *                 type: boolean
 *                 default: false
 *                 description: Pull ONLY syncback-flagged folders guest → host instead of pushing
 *     responses:
 *       200:
 *         description: Sync task chain created
 *       400:
 *         description: Invalid request, missing provisioning config, no eligible folders, or a winrm guest (folders need ssh)
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to create sync task
 */
export const syncZone = async (req, res) => {
  try {
    const zoneName = req.params.name;
    const syncback = req.body?.syncback === true;

    // Validate request. Zone existence answers 404 explicitly — never the
    // error-string sniff (the no-transport refusal contains "not found").
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: `Zone '${zoneName}' not found` });
    }
    const validation = await validateProvisioningRequest(zoneName, zone, true);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const { provisioning, zoneConfig, zoneIP, credentials } = validation;

    // Folders ride rsync/scp over ssh — a winrm guest has none (§5 transport
    // matrix). Refuse up front rather than queueing tasks that must fail.
    if (resolveCommunicatorSettings(zoneConfig.settings || {}).communicator === 'winrm') {
      return res.status(400).json({
        error:
          'Folder sync needs ssh (rsync/scp) — this machine uses the winrm communicator, which cannot carry folders',
      });
    }

    const folders = extractFolders(provisioning);
    if (folders.length === 0) {
      return res.status(400).json({
        error: 'No folders configured in provisioner metadata',
      });
    }

    const targetFolders = syncback ? syncbackEligibleFolders(folders) : folders;
    if (targetFolders.length === 0) {
      return res.status(400).json({
        error: 'No folders flagged syncback: true in provisioner metadata',
      });
    }

    // The parent is a pure anchor (born running, never dispatched);
    // its children start immediately and drive its completion.
    const parentTask = await createTask({
      zone_name: zoneName,
      operation: syncback ? 'zone_syncback_parent' : 'zone_sync_parent',
      metadata: { total_folders: targetFolders.length },
      parent: true,
      parent_task_id: null,
      created_by: req.entity.name,
    });

    await createSequentialTransferTasks(syncback ? 'zone_syncback' : 'zone_sync', targetFolders, {
      zoneName,
      zoneIP,
      credentials,
      provisioning,
      parentTaskId: parentTask.id,
      firstDependsOn: null,
      createdBy: req.entity.name,
    });

    log.api.info('Zone sync task chain created', {
      zone_name: zoneName,
      parent_task_id: parentTask.id,
      folder_count: targetFolders.length,
      syncback,
    });

    return res.json({
      success: true,
      message: `Zone ${syncback ? 'syncback' : 'sync'} task chain created for ${zoneName}`,
      machine_name: zoneName,
      parent_task_id: parentTask.id,
      folder_count: targetFolders.length,
      syncback,
    });
  } catch (error) {
    log.api.error('Failed to create zone sync task', { error: error.message });
    return res.status(500).json({
      error: 'Failed to create zone sync task',
      details: error.message,
    });
  }
};
