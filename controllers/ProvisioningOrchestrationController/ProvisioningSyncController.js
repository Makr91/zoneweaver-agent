/**
 * @fileoverview Ad-hoc zone file sync endpoint
 */

import Zones from '../../models/ZoneModel.js';
import { log } from '../../lib/Logger.js';
import { extractFolders } from '../../lib/ProvisionerConfigBuilder.js';
import { validateProvisioningRequest } from './utils/ValidationHelper.js';
import {
  createTask,
  createSequentialFolderTasks,
  createSequentialSyncbackTasks,
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
 *         description: Invalid request, missing provisioning config, or no eligible folders
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to create sync task
 */
export const syncZone = async (req, res) => {
  try {
    const zoneName = req.params.name;
    const syncback = req.body?.syncback === true;

    // Validate request
    const zone = await Zones.findOne({ where: { name: zoneName } });
    const validation = await validateProvisioningRequest(zoneName, zone, true);
    if (!validation.valid) {
      return res
        .status(validation.error.includes('not found') ? 404 : 400)
        .json({ error: validation.error });
    }

    const { provisioning, zoneIP, credentials } = validation;

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

    if (syncback) {
      await createSequentialSyncbackTasks(
        targetFolders,
        zoneName,
        zoneIP,
        credentials,
        provisioning,
        parentTask.id,
        null,
        req.entity.name
      );
    } else {
      await createSequentialFolderTasks(
        targetFolders,
        zoneName,
        zoneIP,
        credentials,
        provisioning,
        parentTask.id,
        null,
        req.entity.name
      );
    }

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
