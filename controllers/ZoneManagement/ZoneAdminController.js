/**
 * @fileoverview Zone administration verbs (the surveyed zoneadm family, exposed 2026-07-19)
 * @description ready / verify / mark incomplete answer synchronously (fast
 * zoneadm calls); attach / detach / move queue tasks (they can copy or
 * validate storage). Machine-state gates mirror zoneadm's own rules and
 * refuse with the current status named.
 */

import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import { validateZoneName } from '../../lib/ZoneValidation.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { syncZoneToDatabase } from '../../lib/ZoneConfigUtils.js';
import { getSystemZoneStatus } from './ZoneQueryController.js';

const findZone = async (req, res) => {
  const { machineName: zoneName } = req.params;
  if (!validateZoneName(zoneName)) {
    res.status(400).json({ error: 'Invalid machine name' });
    return null;
  }
  const zone = await Zones.findOne({ where: { name: zoneName } });
  if (!zone) {
    res.status(404).json({ error: 'Machine not found' });
    return null;
  }
  return zone;
};

const queueAdminTask = async (req, res, operation, metadata, message) => {
  const zoneName = req.params.machineName;
  const existing = await Tasks.findOne({
    where: { zone_name: zoneName, operation, status: ['pending', 'running'] },
  });
  if (existing) {
    return res.json({
      success: true,
      task_id: existing.id,
      machine_name: zoneName,
      operation,
      status: existing.status,
      message: `${operation} task already queued`,
    });
  }
  const task = await Tasks.create({
    zone_name: zoneName,
    operation,
    priority: TaskPriority.MEDIUM,
    created_by: req.entity.name,
    status: 'pending',
    metadata: metadata ? JSON.stringify(metadata) : null,
  });
  return res.json({
    success: true,
    task_id: task.id,
    machine_name: zoneName,
    operation,
    status: 'pending',
    message,
  });
};

/**
 * @swagger
 * /machines/{machineName}/ready:
 *   post:
 *     summary: Ready the machine (zoneadm ready)
 *     description: Transitions an INSTALLED machine into the ready state (resources assigned, nothing booted). Synchronous.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Machine readied
 *       400:
 *         description: Machine is not installed/halted
 *       404:
 *         description: Machine not found
 *       500:
 *         description: zoneadm ready failed
 */
export const readyZone = async (req, res) => {
  try {
    const zone = await findZone(req, res);
    if (!zone) {
      return undefined;
    }
    const currentStatus = await getSystemZoneStatus(zone.name);
    if (currentStatus !== 'installed') {
      return res.status(400).json({
        error: 'ready applies to installed (halted) machines only',
        current_status: currentStatus,
      });
    }
    const result = await executeCommand(`pfexec zoneadm -z ${zone.name} ready`);
    if (!result.success) {
      return res.status(500).json({ error: 'zoneadm ready failed', details: result.error });
    }
    await syncZoneToDatabase(zone.name);
    log.api.info('Machine readied', { zone_name: zone.name, user: req.entity.name });
    return res.json({ success: true, machine_name: zone.name, message: 'Machine readied' });
  } catch (error) {
    log.api.error('Ready failed', { zone_name: req.params.machineName, error: error.message });
    return res.status(500).json({ error: 'Failed to ready machine', details: error.message });
  }
};

/**
 * @swagger
 * /machines/{machineName}/verify:
 *   post:
 *     summary: Verify the machine configuration (zoneadm verify)
 *     description: |
 *       Runs zoneadm verify against the machine's configuration and answers
 *       the verdict — 200 either way; `valid` carries the result and `output`
 *       the checker's own words. Synchronous, changes nothing.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Verification verdict
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 machine_name: { type: string }
 *                 valid: { type: boolean }
 *                 output: { type: string }
 *       404:
 *         description: Machine not found
 *       500:
 *         description: Failed to run verification
 */
export const verifyZone = async (req, res) => {
  try {
    const zone = await findZone(req, res);
    if (!zone) {
      return undefined;
    }
    const result = await executeCommand(`pfexec zoneadm -z ${zone.name} verify`);
    return res.json({
      success: true,
      machine_name: zone.name,
      valid: result.success,
      output: result.success ? result.output || '' : result.error || result.output || '',
    });
  } catch (error) {
    log.api.error('Verify failed', { zone_name: req.params.machineName, error: error.message });
    return res.status(500).json({ error: 'Failed to verify machine', details: error.message });
  }
};

/**
 * @swagger
 * /machines/{machineName}/mark-incomplete:
 *   post:
 *     summary: Mark the machine incomplete (zoneadm mark incomplete)
 *     description: Forces the machine into the incomplete state (the recover-by-reinstall escape hatch). Synchronous; refuses on a running machine.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Machine marked incomplete
 *       400:
 *         description: Machine is running
 *       404:
 *         description: Machine not found
 *       500:
 *         description: zoneadm mark failed
 */
export const markZoneIncomplete = async (req, res) => {
  try {
    const zone = await findZone(req, res);
    if (!zone) {
      return undefined;
    }
    const currentStatus = await getSystemZoneStatus(zone.name);
    if (currentStatus === 'running') {
      return res.status(400).json({
        error: 'mark incomplete refuses on a running machine — stop it first',
        current_status: currentStatus,
      });
    }
    const result = await executeCommand(`pfexec zoneadm -z ${zone.name} mark incomplete`);
    if (!result.success) {
      return res.status(500).json({ error: 'zoneadm mark failed', details: result.error });
    }
    await syncZoneToDatabase(zone.name);
    log.api.info('Machine marked incomplete', { zone_name: zone.name, user: req.entity.name });
    return res.json({
      success: true,
      machine_name: zone.name,
      message: 'Machine marked incomplete',
    });
  } catch (error) {
    log.api.error('Mark incomplete failed', {
      zone_name: req.params.machineName,
      error: error.message,
    });
    return res.status(500).json({ error: 'Failed to mark machine', details: error.message });
  }
};

/**
 * @swagger
 * /machines/{machineName}/detach:
 *   post:
 *     summary: Detach the machine (zoneadm detach — migration source half)
 *     description: Queues a zone_detach task. The machine must be halted (installed); a detached machine reads configured and its zonepath is ready to move to another host.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Detach task queued
 *       400:
 *         description: Machine is not halted
 *       404:
 *         description: Machine not found
 *       500:
 *         description: Failed to queue detach
 */
export const detachZone = async (req, res) => {
  try {
    const zone = await findZone(req, res);
    if (!zone) {
      return undefined;
    }
    const currentStatus = await getSystemZoneStatus(zone.name);
    if (currentStatus !== 'installed') {
      return res.status(400).json({
        error: 'detach applies to installed (halted) machines only',
        current_status: currentStatus,
      });
    }
    return await queueAdminTask(req, res, 'zone_detach', null, 'Detach task queued');
  } catch (error) {
    log.database.error('Detach queue failed', {
      zone_name: req.params.machineName,
      error: error.message,
    });
    return res.status(500).json({ error: 'Failed to queue detach task' });
  }
};

/**
 * @swagger
 * /machines/{machineName}/attach:
 *   post:
 *     summary: Attach the machine (zoneadm attach — migration target half)
 *     description: |
 *       Queues a zone_attach task against a configured (detached) machine.
 *       `update: true` rides zoneadm attach -u (update the image to this
 *       host); `force: true` rides -F (skip validation).
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               update:
 *                 type: boolean
 *                 default: false
 *               force:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       200:
 *         description: Attach task queued
 *       400:
 *         description: Machine is not in the configured (detached) state
 *       404:
 *         description: Machine not found
 *       500:
 *         description: Failed to queue attach
 */
export const attachZone = async (req, res) => {
  try {
    const zone = await findZone(req, res);
    if (!zone) {
      return undefined;
    }
    const currentStatus = await getSystemZoneStatus(zone.name);
    if (currentStatus !== 'configured') {
      return res.status(400).json({
        error: 'attach applies to configured (detached) machines only',
        current_status: currentStatus,
      });
    }
    const { update = false, force = false } = req.body || {};
    return await queueAdminTask(
      req,
      res,
      'zone_attach',
      { update: update === true, force: force === true },
      'Attach task queued'
    );
  } catch (error) {
    log.database.error('Attach queue failed', {
      zone_name: req.params.machineName,
      error: error.message,
    });
    return res.status(500).json({ error: 'Failed to queue attach task' });
  }
};

/**
 * @swagger
 * /machines/{machineName}/move:
 *   post:
 *     summary: Move the machine's zonepath (zoneadm move)
 *     description: Queues a zone_move task relocating the zonepath (copies data — can run long). The machine must be halted; the document's stored zonepath refreshes when the move lands.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [target_path]
 *             properties:
 *               target_path:
 *                 type: string
 *                 example: "/tank/zones/web-server-01"
 *     responses:
 *       200:
 *         description: Move task queued
 *       400:
 *         description: Machine is not halted, or new_zonepath missing/invalid
 *       404:
 *         description: Machine not found
 *       500:
 *         description: Failed to queue move
 */
export const moveZone = async (req, res) => {
  try {
    const zone = await findZone(req, res);
    if (!zone) {
      return undefined;
    }
    const targetPath = req.body?.target_path;
    if (typeof targetPath !== 'string' || !targetPath.startsWith('/')) {
      return res.status(400).json({ error: 'target_path must be an absolute path' });
    }
    const currentStatus = await getSystemZoneStatus(zone.name);
    if (currentStatus !== 'installed' && currentStatus !== 'configured') {
      return res.status(400).json({
        error: 'move applies to halted machines only',
        current_status: currentStatus,
      });
    }
    return await queueAdminTask(
      req,
      res,
      'zone_move',
      { target_path: targetPath },
      'Move task queued'
    );
  } catch (error) {
    log.database.error('Move queue failed', {
      zone_name: req.params.machineName,
      error: error.message,
    });
    return res.status(500).json({ error: 'Failed to queue move task' });
  }
};
