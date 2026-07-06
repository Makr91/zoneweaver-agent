/**
 * @fileoverview Ad-hoc zone file sync endpoint
 */

import Zones from '../../models/ZoneModel.js';
import { log } from '../../lib/Logger.js';
import { validateProvisioningRequest } from './utils/ValidationHelper.js';
import { createTask, createSequentialFolderTasks } from './utils/TaskCreationHelper.js';

/**
 * @swagger
 * /machines/{name}/sync:
 *   post:
 *     summary: Sync machine files ad-hoc
 *     description: |
 *       Creates a zone_sync task to sync provisioning files to the machine.
 *       This is independent of the full provisioning pipeline and can be called
 *       anytime after SSH is accessible.
 *
 *       Prerequisites:
 *       - Machine must be running
 *       - Machine must have provisioning config with sync_folders
 *       - SSH must be accessible
 *     tags: [Provisioning Tasks]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Sync task created
 *       400:
 *         description: Invalid request or missing provisioning config
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to create sync task
 */
export const syncZone = async (req, res) => {
  try {
    const zoneName = req.params.name;

    // Validate request
    const zone = await Zones.findOne({ where: { name: zoneName } });
    const validation = await validateProvisioningRequest(zoneName, zone, true);
    if (!validation.valid) {
      return res
        .status(validation.error.includes('not found') ? 404 : 400)
        .json({ error: validation.error });
    }

    const { provisioning, zoneIP, credentials } = validation;

    // Check if there are folders configured
    const folders = provisioning.folders || provisioning.sync_folders || [];
    if (folders.length === 0) {
      return res.status(400).json({
        error: 'No folders configured in provisioner metadata',
      });
    }

    // Create parent task for folder sync
    const syncParentTask = await createTask({
      zone_name: zoneName,
      operation: 'zone_sync_parent',
      metadata: { total_folders: folders.length },
      depends_on: null,
      parent_task_id: null,
      created_by: req.entity.name,
    });

    // Create individual sync tasks sequentially (each depends on previous)
    await createSequentialFolderTasks(
      folders,
      zoneName,
      zoneIP,
      credentials,
      provisioning,
      syncParentTask.id,
      req.entity.name
    );

    log.api.info('Zone sync task chain created', {
      zone_name: zoneName,
      parent_task_id: syncParentTask.id,
      folder_count: folders.length,
    });

    return res.json({
      success: true,
      message: `Zone sync task chain created for ${zoneName}`,
      machine_name: zoneName,
      parent_task_id: syncParentTask.id,
      folder_count: folders.length,
    });
  } catch (error) {
    log.api.error('Failed to create zone sync task', { error: error.message });
    return res.status(500).json({
      error: 'Failed to create zone sync task',
      details: error.message,
    });
  }
};
