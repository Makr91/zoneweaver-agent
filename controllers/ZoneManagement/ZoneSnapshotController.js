/**
 * @fileoverview Machine snapshot endpoints (machine-snapshots token, Go wire shapes)
 * @description Lists EVERY snapshot on the zone's ZFS tree (any producer — agent,
 * rotation service, Snapshoter.sh cron) with hold counts, and queues take/restore/
 * delete tasks. Take accepts a literal name, or prefix+retention (Snapshoter-style
 * rotation semantics), plus quiesce (qga fsfreeze).
 */

import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import { validateZoneName } from '../../lib/ZoneValidation.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { getZoneConfig } from '../../lib/ZoneConfigUtils.js';
import { collectSnapshotTargets } from '../TaskManager/ZoneSnapshotManager.js';

const SNAPSHOT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;

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

const queueSnapshotTask = async (req, res, operation, metadata, message) => {
  const zone = await findZone(req, res);
  if (!zone) {
    return undefined;
  }
  try {
    const task = await Tasks.create({
      zone_name: zone.name,
      operation,
      priority: operation === 'snapshot_restore' ? TaskPriority.HIGH : TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: JSON.stringify(metadata),
    });
    return res.json({
      success: true,
      task_id: task.id,
      machine_name: zone.name,
      operation,
      status: 'pending',
      message,
    });
  } catch (error) {
    log.database.error('Failed to queue snapshot task', {
      zone_name: zone.name,
      operation,
      error: error.message,
    });
    return res.status(500).json({ error: `Failed to queue ${operation} task` });
  }
};

/**
 * @swagger
 * /machines/{machineName}/snapshots:
 *   get:
 *     summary: List the machine's snapshots
 *     description: Every snapshot across the zone's ZFS tree (root dataset recursively plus out-of-tree media), any producer, grouped by snapshot name with hold counts.
 *     tags: [Machine Snapshots]
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
 *         description: Snapshot list
 */
export const listMachineSnapshots = async (req, res) => {
  const zone = await findZone(req, res);
  if (!zone) {
    return undefined;
  }
  try {
    const zoneConfig = await getZoneConfig(zone.name);
    const targets = collectSnapshotTargets(zoneConfig);
    const commands = [];
    if (targets.root) {
      commands.push(
        `pfexec zfs list -H -p -t snapshot -o name,creation,used,userrefs -r ${targets.root}`
      );
    }
    for (const dataset of targets.externals) {
      commands.push(
        `pfexec zfs list -H -p -t snapshot -o name,creation,used,userrefs -d 1 ${dataset}`
      );
    }

    const grouped = new Map();
    const results = await Promise.all(commands.map(command => executeCommand(command)));
    for (const result of results) {
      if (!result.success) {
        continue;
      }
      for (const line of result.output.split('\n')) {
        const [full, creation, used, userrefs] = line.trim().split('\t');
        if (!full || !full.includes('@')) {
          continue;
        }
        const [, name] = full.split('@');
        const entry = grouped.get(name) || {
          name,
          created: null,
          datasets: 0,
          used_bytes: 0,
          holds: 0,
        };
        entry.datasets += 1;
        entry.used_bytes += Number(used) || 0;
        entry.holds += Number(userrefs) || 0;
        const created = Number(creation) ? new Date(Number(creation) * 1000).toISOString() : null;
        if (created && (!entry.created || created < entry.created)) {
          entry.created = created;
        }
        grouped.set(name, entry);
      }
    }

    const snapshots = [...grouped.values()].sort((a, b) =>
      (b.created || '').localeCompare(a.created || '')
    );
    return res.json({ machine_name: zone.name, snapshots, total: snapshots.length });
  } catch (error) {
    log.api.error('Failed to list machine snapshots', {
      zone_name: zone.name,
      error: error.message,
    });
    return res.status(500).json({ error: 'Failed to list snapshots' });
  }
};

/**
 * @swagger
 * /machines/{machineName}/snapshots:
 *   post:
 *     summary: Take a machine snapshot
 *     description: Body carries a literal name, OR prefix (+ retention) for Snapshoter-style rotation naming and pruning. quiesce runs qga fsfreeze around the snapshot when the guest agent answers.
 *     tags: [Machine Snapshots]
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
 *             properties:
 *               name:
 *                 type: string
 *               prefix:
 *                 type: string
 *                 description: Rotation prefix — the snapshot is named prefix-YYYYMMDD-HHMM
 *               retention:
 *                 type: integer
 *                 description: With prefix, keep the newest N prefix snapshots (0 = keep all)
 *               description:
 *                 type: string
 *               quiesce:
 *                 type: boolean
 *                 default: false
 *               live:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Snapshot task queued
 */
export const takeMachineSnapshot = (req, res) => {
  const {
    name,
    prefix,
    retention = 0,
    description,
    quiesce = false,
    live = false,
  } = req.body || {};
  if (!name && !prefix) {
    return res.status(400).json({ error: 'name or prefix is required' });
  }
  const label = name || prefix;
  if (!SNAPSHOT_NAME_PATTERN.test(label)) {
    return res.status(400).json({ error: 'snapshot name/prefix contains unsupported characters' });
  }
  return queueSnapshotTask(
    req,
    res,
    'snapshot_take',
    { snapshot_name: name, prefix, retention, description, quiesce, live },
    'Snapshot task queued successfully'
  );
};

/**
 * @swagger
 * /machines/{machineName}/snapshots/{snapshotName}/restore:
 *   post:
 *     summary: Restore the machine to a snapshot
 *     description: Rolls every dataset carrying the snapshot back to it (machine must be powered off; later snapshots are destroyed by the rollback).
 *     tags: [Machine Snapshots]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: snapshotName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Restore task queued
 */
export const restoreMachineSnapshot = (req, res) => {
  const { snapshotName } = req.params;
  if (!SNAPSHOT_NAME_PATTERN.test(snapshotName)) {
    return res.status(400).json({ error: 'snapshot name contains unsupported characters' });
  }
  return queueSnapshotTask(
    req,
    res,
    'snapshot_restore',
    { snapshot_name: snapshotName },
    'Snapshot restore task queued successfully'
  );
};

/**
 * @swagger
 * /machines/{machineName}/snapshots/{snapshotName}:
 *   delete:
 *     summary: Delete a machine snapshot
 *     tags: [Machine Snapshots]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: snapshotName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Delete task queued
 */
export const deleteMachineSnapshot = (req, res) => {
  const { snapshotName } = req.params;
  if (!SNAPSHOT_NAME_PATTERN.test(snapshotName)) {
    return res.status(400).json({ error: 'snapshot name contains unsupported characters' });
  }
  return queueSnapshotTask(
    req,
    res,
    'snapshot_delete',
    { snapshot_name: snapshotName },
    'Snapshot delete task queued successfully'
  );
};
