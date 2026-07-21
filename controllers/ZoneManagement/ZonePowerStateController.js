import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';
import { validateZoneName } from '../../lib/ZoneValidation.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { hasSuspendCheckpoint } from '../../lib/SuspendCheckpoint.js';
import { getSystemZoneStatus } from './ZoneQueryController.js';

/**
 * @fileoverview Zone reset, suspend, resume, and NMI controllers
 */

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
