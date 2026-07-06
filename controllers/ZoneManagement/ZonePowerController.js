import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import { validateZoneName } from '../../lib/ZoneValidation.js';
import { getSystemZoneStatus } from './ZoneQueryController.js';

/**
 * @fileoverview Zone power controllers - start, stop, restart
 */

/**
 * @swagger
 * /machines/{machineName}/start:
 *   post:
 *     summary: Start machine
 *     description: Queues a task to start the specified machine (zone)
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine to start
 *     responses:
 *       200:
 *         description: Start task queued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 task_id:
 *                   type: string
 *                 machine_name:
 *                   type: string
 *                 operation:
 *                   type: string
 *                 status:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid zone name or zone already running
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to queue start task
 */
export const startZone = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    // Check if zone exists in database
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    // Get current system status
    const currentStatus = await getSystemZoneStatus(zoneName);

    // If already running, no need to start
    if (currentStatus === 'running') {
      return res.json({
        success: true,
        machine_name: zoneName,
        operation: 'start',
        status: 'already_running',
        message: 'Zone is already running',
      });
    }

    // Check for existing pending/running start tasks
    const existingTask = await Tasks.findOne({
      where: {
        zone_name: zoneName,
        operation: 'start',
        status: ['pending', 'running'],
      },
    });

    if (existingTask) {
      return res.json({
        success: true,
        task_id: existingTask.id,
        machine_name: zoneName,
        operation: 'start',
        status: existingTask.status,
        message: 'Start task already queued',
      });
    }

    // Create new start task
    const task = await Tasks.create({
      zone_name: zoneName,
      operation: 'start',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
    });

    return res.json({
      success: true,
      task_id: task.id,
      machine_name: zoneName,
      operation: 'start',
      status: 'pending',
      message: 'Start task queued successfully',
    });
  } catch (error) {
    log.database.error('Database error starting zone task', {
      error: error.message,
      zone_name: req.params.machineName,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue start task' });
  }
};

/**
 * @swagger
 * /machines/{machineName}/stop:
 *   post:
 *     summary: Stop machine
 *     description: Queues a task to stop the specified machine (zone)
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine to stop
 *       - in: query
 *         name: force
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Force shutdown (halt instead of graceful shutdown)
 *     responses:
 *       200:
 *         description: Stop task queued successfully
 *       400:
 *         description: Invalid zone name or zone already stopped
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to queue stop task
 */
export const stopZone = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;
    const { force = false } = req.query;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    const currentStatus = await getSystemZoneStatus(zoneName);

    // If already stopped, no need to stop
    if (currentStatus === 'configured' || currentStatus === 'installed') {
      return res.json({
        success: true,
        machine_name: zoneName,
        operation: 'stop',
        status: 'already_stopped',
        message: 'Zone is already stopped',
      });
    }

    // Cancel any pending start tasks for this zone
    await Tasks.update(
      { status: 'cancelled' },
      {
        where: {
          zone_name: zoneName,
          operation: 'start',
          status: 'pending',
        },
      }
    );

    // Check for existing stop task
    const existingTask = await Tasks.findOne({
      where: {
        zone_name: zoneName,
        operation: 'stop',
        status: ['pending', 'running'],
      },
    });

    if (existingTask) {
      return res.json({
        success: true,
        task_id: existingTask.id,
        machine_name: zoneName,
        operation: 'stop',
        status: existingTask.status,
        message: 'Stop task already queued',
      });
    }

    const task = await Tasks.create({
      zone_name: zoneName,
      operation: 'stop',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
    });

    return res.json({
      success: true,
      task_id: task.id,
      machine_name: zoneName,
      operation: 'stop',
      status: 'pending',
      message: 'Stop task queued successfully',
      force,
    });
  } catch (error) {
    log.database.error('Database error stopping zone task', {
      error: error.message,
      zone_name: req.params.machineName,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue stop task' });
  }
};

/**
 * @swagger
 * /machines/{machineName}/restart:
 *   post:
 *     summary: Restart machine
 *     description: Queues tasks to stop and then start the specified machine (zone)
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine to restart
 *     responses:
 *       200:
 *         description: Restart tasks queued successfully
 *       400:
 *         description: Invalid zone name
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to queue restart tasks
 */
export const restartZone = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    // Create stop task
    const stopTask = await Tasks.create({
      zone_name: zoneName,
      operation: 'stop',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
    });

    // Create start task that depends on stop task
    const startTask = await Tasks.create({
      zone_name: zoneName,
      operation: 'start',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      depends_on: stopTask.id,
      status: 'pending',
    });

    return res.json({
      success: true,
      restart_tasks: {
        stop_task_id: stopTask.id,
        start_task_id: startTask.id,
      },
      machine_name: zoneName,
      operation: 'restart',
      status: 'pending',
      message: 'Restart tasks queued successfully',
    });
  } catch (error) {
    log.database.error('Database error restarting zone task', {
      error: error.message,
      zone_name: req.params.machineName,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue restart tasks' });
  }
};
