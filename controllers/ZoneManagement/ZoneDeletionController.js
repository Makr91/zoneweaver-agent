import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import { validateZoneName } from '../../lib/ZoneValidation.js';
import { getSystemZoneStatus } from './ZoneQueryController.js';

/**
 * @fileoverview Zone deletion controller
 */

/**
 * @swagger
 * /machines/{machineName}:
 *   delete:
 *     summary: Delete machine
 *     description: Queues tasks to stop, uninstall, and delete the specified machine (zone)
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine to delete
 *       - in: query
 *         name: force
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Force deletion even if zone is running
 *       - in: query
 *         name: cleanup_disks
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Also destroy the machine's ZFS datasets (boot volume, zone root dataset) after zone deletion — the converged cross-agent key. Only agent-stamped datasets die; external/user-attached datasets are always preserved.
 *       - in: query
 *         name: cleanup_networking
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Also tear down the machine's network resources after zone deletion — its IP address objects are deleted (DHCP leases released) and its VNICs destroyed; physical links are only dissociated. When false, interfaces are dissociated from the zone but left intact.
 *     responses:
 *       200:
 *         description: Delete tasks queued successfully
 *       400:
 *         description: Invalid zone name or zone is running without force
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to queue delete tasks
 */
export const deleteZone = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;
    const { force = false, cleanup_disks = false, cleanup_networking = false } = req.query;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    const currentStatus = await getSystemZoneStatus(zoneName);

    const tasks = [];

    // If zone is running and force is not specified, require explicit force
    if (currentStatus === 'running' && !force) {
      return res.status(400).json({
        error: 'Zone is running. Use force=true to stop and delete',
        current_status: currentStatus,
      });
    }

    // Build delete task metadata
    const deleteMetadata = JSON.stringify({
      cleanup_disks: cleanup_disks === 'true' || cleanup_disks === true,
      cleanup_networking: cleanup_networking === 'true' || cleanup_networking === true,
    });

    // If zone is running, create stop task first
    if (currentStatus === 'running') {
      const stopTask = await Tasks.create({
        zone_name: zoneName,
        operation: 'stop',
        priority: TaskPriority.CRITICAL,
        created_by: req.entity.name,
        status: 'pending',
      });
      tasks.push(stopTask);

      // Create delete task that depends on stop
      const deleteTask = await Tasks.create({
        zone_name: zoneName,
        operation: 'delete',
        priority: TaskPriority.CRITICAL,
        created_by: req.entity.name,
        depends_on: stopTask.id,
        metadata: deleteMetadata,
        status: 'pending',
      });
      tasks.push(deleteTask);
    } else {
      // Zone is not running, just delete
      const deleteTask = await Tasks.create({
        zone_name: zoneName,
        operation: 'delete',
        priority: TaskPriority.CRITICAL,
        created_by: req.entity.name,
        metadata: deleteMetadata,
        status: 'pending',
      });
      tasks.push(deleteTask);
    }

    return res.json({
      success: true,
      delete_tasks: tasks.map(t => t.id),
      machine_name: zoneName,
      operation: 'delete',
      status: 'pending',
      message: 'Delete tasks queued successfully',
      force,
    });
  } catch (error) {
    log.database.error('Database error deleting zone task', {
      error: error.message,
      zone_name: req.params.machineName,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue delete tasks' });
  }
};
