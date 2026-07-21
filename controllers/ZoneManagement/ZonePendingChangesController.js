import Zones from '../../models/ZoneModel.js';
import { log } from '../../lib/Logger.js';
import { validateZoneName } from '../../lib/ZoneValidation.js';
import { clearPendingChanges } from '../../lib/ZoneConfigMutators.js';
import { getSystemZoneStatus } from './ZoneQueryController.js';
import { STOPPED_STATUSES } from './ZoneModification/ZoneModifyConstants.js';
import { parsePendingSet, queueModifyTask } from './ZoneModification/ZoneModifyQueue.js';

/**
 * @fileoverview Zone pending-changes controller — the accrue contract's cancel
 * and apply-now halves, plus the shared queue helper the power paths chain on.
 */

/**
 * Queue a zone_modify task carrying the accrued pending set (the accrue
 * contract's apply half; _apply_pending makes the executor clear it on
 * success). Null when nothing is pending or queueing failed.
 */
export const queuePendingApply = async (zone, createdBy) => {
  const pending = parsePendingSet(zone);
  if (Object.keys(pending).length === 0) {
    return null;
  }
  try {
    return await queueModifyTask(zone.name, { ...pending, _apply_pending: true }, createdBy);
  } catch (error) {
    log.database.error('Failed to queue pending-changes apply', {
      zone_name: zone.name,
      error: error.message,
    });
    return null;
  }
};

/**
 * @swagger
 * /machines/{machineName}/pending-changes:
 *   delete:
 *     summary: Cancel the machine's accrued pending changes
 *     description: Clears the set a PUT against a non-powered-off machine stored.
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
 *         description: Pending changes cleared
 *       404:
 *         description: Machine not found
 */
export const clearZonePendingChanges = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;
    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Machine not found' });
    }
    const clearedKeys = (await clearPendingChanges(zoneName)) || [];
    log.api.info('Pending changes cleared', {
      zone_name: zoneName,
      keys: clearedKeys.length,
      user: req.entity.name,
    });
    return res.json({
      success: true,
      machine_name: zoneName,
      cleared_keys: clearedKeys,
      message: 'Pending changes cleared',
    });
  } catch (error) {
    log.database.error('Failed to clear pending changes', {
      error: error.message,
      zone_name: req.params.machineName,
    });
    return res.status(500).json({ error: 'Failed to clear pending changes' });
  }
};

/**
 * @swagger
 * /machines/{machineName}/pending-changes/apply:
 *   post:
 *     summary: Apply the accrued pending changes now
 *     description: Queues the apply against a powered-off machine — they apply automatically at the next agent-driven power cycle otherwise.
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
 *         description: Apply task queued
 *       400:
 *         description: Nothing pending, or the machine is not powered off
 */
export const applyZonePendingChanges = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;
    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Machine not found' });
    }
    if (Object.keys(parsePendingSet(zone)).length === 0) {
      return res.status(400).json({ error: 'No pending changes to apply' });
    }
    const currentStatus = await getSystemZoneStatus(zoneName);
    if (!STOPPED_STATUSES.includes(currentStatus)) {
      return res.status(400).json({
        error:
          'Machine must be powered off to apply pending changes now — they apply automatically at the next agent-driven power cycle',
      });
    }
    const task = await queuePendingApply(zone, req.entity.name);
    if (!task) {
      return res.status(500).json({ error: 'Failed to queue pending-changes apply' });
    }
    return res.json({
      success: true,
      task_id: task.id,
      machine_name: zoneName,
      operation: 'zone_modify',
      status: 'pending',
      message: 'Pending changes apply queued',
    });
  } catch (error) {
    log.database.error('Failed to apply pending changes', {
      error: error.message,
      zone_name: req.params.machineName,
    });
    return res.status(500).json({ error: 'Failed to apply pending changes' });
  }
};
