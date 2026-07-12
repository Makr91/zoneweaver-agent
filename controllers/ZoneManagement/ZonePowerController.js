import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { Op } from 'sequelize';
import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';
import { validateZoneName } from '../../lib/ZoneValidation.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { hasSuspendCheckpoint } from '../../lib/SuspendCheckpoint.js';
import { getSystemZoneStatus } from './ZoneQueryController.js';
import { queuePendingApply } from './ZoneModificationController.js';

/**
 * @fileoverview Zone power controllers - start, stop, restart, reset, suspend, resume, nmi
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

    // Accrued pending changes apply FIRST (modify → start chain): a bad
    // pending value fails the boot honestly instead of booting and pretending
    // the changes applied.
    const applyTask = await queuePendingApply(zone, req.entity.name);

    const task = await Tasks.create({
      zone_name: zoneName,
      operation: 'start',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      depends_on: applyTask ? applyTask.id : null,
      status: 'pending',
    });

    return res.json({
      success: true,
      task_id: task.id,
      machine_name: zoneName,
      operation: 'start',
      status: 'pending',
      message: applyTask
        ? 'Pending changes apply queued, start chained after it'
        : 'Start task queued successfully',
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

    // Accrued pending changes apply right after the power-off.
    const applyTask = await queuePendingApply(zone, req.entity.name);
    if (applyTask) {
      await applyTask.update({ depends_on: task.id });
    }

    return res.json({
      success: true,
      task_id: task.id,
      machine_name: zoneName,
      operation: 'stop',
      status: 'pending',
      message: applyTask
        ? 'Stop task queued, pending changes apply chained after it'
        : 'Stop task queued successfully',
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

    // Double-POST dedup (the reuse check start/stop already have): an
    // unfinished stop with a pending start chained behind it — directly or
    // through the pending-changes apply hop — IS a queued restart. Answer
    // that pair instead of queueing a second power cycle.
    const existingStop = await Tasks.findOne({
      where: { zone_name: zoneName, operation: 'stop', status: ['pending', 'running'] },
      order: [['created_at', 'DESC']],
    });
    if (existingStop) {
      const pendingStarts = await Tasks.findAll({
        where: {
          zone_name: zoneName,
          operation: 'start',
          status: 'pending',
          depends_on: { [Op.ne]: null },
        },
      });
      let chainedStart = pendingStarts.find(t => t.depends_on === existingStop.id);
      if (!chainedStart && pendingStarts.length > 0) {
        const middles = await Tasks.findAll({
          where: {
            id: { [Op.in]: pendingStarts.map(t => t.depends_on) },
            depends_on: existingStop.id,
          },
          attributes: ['id'],
        });
        const middleIds = new Set(middles.map(middle => middle.id));
        chainedStart = pendingStarts.find(t => middleIds.has(t.depends_on));
      }
      if (chainedStart) {
        return res.json({
          success: true,
          restart_tasks: {
            stop_task_id: existingStop.id,
            start_task_id: chainedStart.id,
          },
          machine_name: zoneName,
          operation: 'restart',
          status: 'pending',
          message: 'Restart tasks already queued',
        });
      }
    }

    // Create stop task
    const stopTask = await Tasks.create({
      zone_name: zoneName,
      operation: 'stop',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
    });

    // Accrued pending changes slot between stop and start.
    let startDependsOn = stopTask.id;
    const applyTask = await queuePendingApply(zone, req.entity.name);
    if (applyTask) {
      await applyTask.update({ depends_on: stopTask.id });
      startDependsOn = applyTask.id;
    }

    // Create start task that depends on stop task
    const startTask = await Tasks.create({
      zone_name: zoneName,
      operation: 'start',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      depends_on: startDependsOn,
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

/**
 * @swagger
 * /machines/{machineName}/reset:
 *   post:
 *     summary: Reset machine
 *     description: |
 *       Hard-bounces a RUNNING machine (the reset button — zoneadm reboot
 *       skips any in-guest shutdown). Shared verb with the Go agent. Machines
 *       that are not running answer 400; a double POST returns the already
 *       queued reset task.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine to reset
 *     responses:
 *       200:
 *         description: Reset task queued successfully
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
 *         description: Machine is not running
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to queue reset task
 */
export const resetZone = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    const currentStatus = await getSystemZoneStatus(zoneName);
    if (currentStatus !== 'running') {
      return res.status(400).json({
        error: 'Machine is not running — reset applies to running machines only',
        current_status: currentStatus,
      });
    }

    // Double-POST dedup (start/stop parity)
    const existingTask = await Tasks.findOne({
      where: {
        zone_name: zoneName,
        operation: 'reset',
        status: ['pending', 'running'],
      },
    });
    if (existingTask) {
      return res.json({
        success: true,
        task_id: existingTask.id,
        machine_name: zoneName,
        operation: 'reset',
        status: existingTask.status,
        message: 'Reset task already queued',
      });
    }

    const task = await Tasks.create({
      zone_name: zoneName,
      operation: 'reset',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
    });

    return res.json({
      success: true,
      task_id: task.id,
      machine_name: zoneName,
      operation: 'reset',
      status: 'pending',
      message: 'Reset task queued successfully',
    });
  } catch (error) {
    log.database.error('Database error resetting zone task', {
      error: error.message,
      zone_name: req.params.machineName,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue reset task' });
  }
};

/**
 * @swagger
 * /machines/{machineName}/suspend:
 *   post:
 *     summary: Suspend machine
 *     description: |
 *       Checkpoints a RUNNING bhyve machine's full state to disk
 *       (bhyvectl --suspend) and powers it off — the Go agent's suspend
 *       (savestate) verb. Resume with POST /machines/{machineName}/resume;
 *       a plain start also restores the checkpoint (and falls back to a
 *       fresh boot, discarding it, when the restore refuses). bhyve-brand
 *       machines only; a double POST returns the already queued task.
 *       EXPERIMENTAL — requires experimental.enabled (503 otherwise; the
 *       machine-suspend token is advertised only while it is on).
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine to suspend
 *     responses:
 *       200:
 *         description: Suspend task queued successfully
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
 *         description: Machine is not running or not a bhyve machine
 *       404:
 *         description: Zone not found
 *       503:
 *         description: Experimental features are disabled
 *       500:
 *         description: Failed to queue suspend task
 */
export const suspendZone = async (req, res) => {
  try {
    if (!config.get('experimental.enabled')) {
      return res
        .status(503)
        .json({ error: 'Suspend is experimental — enable experimental.enabled to use it' });
    }

    const { machineName: zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    if (zone.brand !== 'bhyve') {
      return res.status(400).json({
        error: 'Suspend applies to bhyve machines only',
        brand: zone.brand,
      });
    }

    const currentStatus = await getSystemZoneStatus(zoneName);
    if (currentStatus !== 'running') {
      return res.status(400).json({
        error: 'Can only suspend a running machine',
        current_status: currentStatus,
      });
    }

    // Double-POST dedup (start/stop parity)
    const existingTask = await Tasks.findOne({
      where: {
        zone_name: zoneName,
        operation: 'suspend',
        status: ['pending', 'running'],
      },
    });
    if (existingTask) {
      return res.json({
        success: true,
        task_id: existingTask.id,
        machine_name: zoneName,
        operation: 'suspend',
        status: existingTask.status,
        message: 'Suspend task already queued',
      });
    }

    const task = await Tasks.create({
      zone_name: zoneName,
      operation: 'suspend',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
    });

    return res.json({
      success: true,
      task_id: task.id,
      machine_name: zoneName,
      operation: 'suspend',
      status: 'pending',
      message: 'Suspend task queued successfully',
    });
  } catch (error) {
    log.database.error('Database error suspending zone task', {
      error: error.message,
      zone_name: req.params.machineName,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue suspend task' });
  }
};

/**
 * @swagger
 * /machines/{machineName}/resume:
 *   post:
 *     summary: Resume machine
 *     description: |
 *       Boots a suspended bhyve machine from its checkpoint (the state
 *       POST /machines/{machineName}/suspend wrote). The explicit verb never
 *       falls back: a restore failure keeps the checkpoint for diagnosis —
 *       start is the verb that discards a refusing checkpoint and boots
 *       fresh. Accrued pending changes are deliberately NOT applied here:
 *       the restored state expects the exact configuration it was saved
 *       with; they apply at the next real power cycle.
 *       EXPERIMENTAL — requires experimental.enabled (503 otherwise).
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine to resume
 *     responses:
 *       200:
 *         description: Resume task queued successfully
 *       400:
 *         description: Machine is running, has no suspend checkpoint, or is not a bhyve machine
 *       404:
 *         description: Zone not found
 *       503:
 *         description: Experimental features are disabled
 *       500:
 *         description: Failed to queue resume task
 */
export const resumeZone = async (req, res) => {
  try {
    if (!config.get('experimental.enabled')) {
      return res
        .status(503)
        .json({ error: 'Resume is experimental — enable experimental.enabled to use it' });
    }

    const { machineName: zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    if (zone.brand !== 'bhyve') {
      return res.status(400).json({
        error: 'Resume applies to bhyve machines only',
        brand: zone.brand,
      });
    }

    const currentStatus = await getSystemZoneStatus(zoneName);
    if (currentStatus === 'running') {
      return res.status(400).json({
        error: 'Machine is already running',
        current_status: currentStatus,
      });
    }

    let zoneConfig = zone.configuration || {};
    if (typeof zoneConfig === 'string') {
      try {
        zoneConfig = JSON.parse(zoneConfig);
      } catch {
        zoneConfig = {};
      }
    }
    if (!(await hasSuspendCheckpoint(zoneConfig.zonepath))) {
      return res.status(400).json({
        error: 'Machine has no suspend checkpoint — nothing to resume',
      });
    }

    // Double-POST dedup (start/stop parity)
    const existingTask = await Tasks.findOne({
      where: {
        zone_name: zoneName,
        operation: 'resume',
        status: ['pending', 'running'],
      },
    });
    if (existingTask) {
      return res.json({
        success: true,
        task_id: existingTask.id,
        machine_name: zoneName,
        operation: 'resume',
        status: existingTask.status,
        message: 'Resume task already queued',
      });
    }

    const task = await Tasks.create({
      zone_name: zoneName,
      operation: 'resume',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
    });

    return res.json({
      success: true,
      task_id: task.id,
      machine_name: zoneName,
      operation: 'resume',
      status: 'pending',
      message: 'Resume task queued successfully',
    });
  } catch (error) {
    log.database.error('Database error resuming zone task', {
      error: error.message,
      zone_name: req.params.machineName,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue resume task' });
  }
};

/**
 * @swagger
 * /machines/{machineName}/nmi:
 *   post:
 *     summary: Inject a non-maskable interrupt
 *     description: |
 *       Injects an NMI into a RUNNING bhyve machine (bhyvectl --inject-nmi) —
 *       the diagnostic hammer for triggering guest crash dumps or dropping
 *       into a kernel debugger. Synchronous; bhyve-brand machines only.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine
 *     responses:
 *       200:
 *         description: NMI injected
 *       400:
 *         description: Machine is not running or not a bhyve machine
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to inject NMI
 */
export const injectNmi = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    if (zone.brand !== 'bhyve') {
      return res.status(400).json({
        error: 'NMI injection applies to bhyve machines only',
        brand: zone.brand,
      });
    }

    const currentStatus = await getSystemZoneStatus(zoneName);
    if (currentStatus !== 'running') {
      return res.status(400).json({
        error: 'Machine is not running — NMI applies to running machines only',
        current_status: currentStatus,
      });
    }

    const result = await executeCommand(`pfexec bhyvectl --vm=${zoneName} --inject-nmi`);
    if (!result.success) {
      return res.status(500).json({
        error: 'Failed to inject NMI',
        details: result.error,
      });
    }

    log.api.info('NMI injected', { zone_name: zoneName, user: req.entity.name });

    return res.json({
      success: true,
      machine_name: zoneName,
      message: `NMI injected into ${zoneName}`,
    });
  } catch (error) {
    log.api.error('Error injecting NMI', {
      error: error.message,
      zone_name: req.params.machineName,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to inject NMI' });
  }
};
