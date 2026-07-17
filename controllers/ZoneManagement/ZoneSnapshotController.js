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
 *     description: |
 *       Every snapshot across the machine's ZFS tree (root dataset recursively plus
 *       out-of-tree media), whatever produced it, grouped by snapshot name.
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
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 machine_name:
 *                   type: string
 *                 total:
 *                   type: integer
 *                 snapshots:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 *                         nullable: true
 *                         description: The description given at take time (a ZFS user property); null when none
 *                       created:
 *                         type: string
 *                         format: date-time
 *                       datasets:
 *                         type: integer
 *                         description: How many datasets carry this snapshot
 *                       dataset_names:
 *                         type: array
 *                         items:
 *                           type: string
 *                         description: The datasets carrying it — the hold/release API is dataset-level (/storage/snapshots/{dataset}@{name}/holds), so these are the handles you act on
 *                       used_bytes:
 *                         type: integer
 *                       holds:
 *                         type: integer
 *                         description: Total ZFS holds (userrefs) across those datasets
 */
export const listMachineSnapshots = async (req, res) => {
  const zone = await findZone(req, res);
  if (!zone) {
    return undefined;
  }
  try {
    const zoneConfig = await getZoneConfig(zone.name);
    const targets = collectSnapshotTargets(zoneConfig);
    // The description rides a ZFS user property that snapshot_take writes —
    // it has to be READ BACK here, or a caller's description is written and
    // then lost forever. dataset_names must ride too: the hold/release API is
    // dataset-level, so a bare count leaves a caller unable to act on it.
    const FIELDS = 'name,creation,used,userrefs,zoneweaver:description';
    const commands = [];
    if (targets.root) {
      commands.push(`pfexec zfs list -H -p -t snapshot -o ${FIELDS} -r ${targets.root}`);
    }
    for (const dataset of targets.externals) {
      commands.push(`pfexec zfs list -H -p -t snapshot -o ${FIELDS} -d 1 ${dataset}`);
    }

    const grouped = new Map();
    const results = await Promise.all(commands.map(command => executeCommand(command)));
    for (const result of results) {
      if (!result.success) {
        continue;
      }
      for (const line of result.output.split('\n')) {
        const [full, creation, used, userrefs, description] = line.trim().split('\t');
        if (!full || !full.includes('@')) {
          continue;
        }
        const [dataset, name] = full.split('@');
        const entry = grouped.get(name) || {
          name,
          description: null,
          created: null,
          datasets: 0,
          dataset_names: [],
          used_bytes: 0,
          holds: 0,
        };
        entry.datasets += 1;
        entry.dataset_names.push(dataset);
        entry.used_bytes += Number(used) || 0;
        entry.holds += Number(userrefs) || 0;
        // zfs prints an unset user property as '-'; the description is written
        // on the zone-root snapshot only, so take the first real one.
        if (!entry.description && description && description !== '-') {
          entry.description = description;
        }
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
 *   put:
 *     summary: Rename a machine snapshot and/or edit its description
 *     description: |
 *       Queues a snapshot_modify task (shared wire with the Go agent).
 *       new_name renames the snapshot across the machine's whole ZFS tree
 *       (`zfs rename -r` on the root plus the out-of-tree media); description
 *       rewrites the zoneweaver:description user property on the zone-root
 *       snapshot (empty string clears it). Either or both fields.
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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               new_name:
 *                 type: string
 *                 description: New snapshot name (renamed across every dataset carrying it)
 *               description:
 *                 type: string
 *                 description: New description ('' clears it)
 *     responses:
 *       200:
 *         description: Modify task queued
 *       400:
 *         description: Neither new_name nor description provided, or invalid names
 */
export const modifyMachineSnapshot = (req, res) => {
  const { snapshotName } = req.params;
  const { new_name, description } = req.body || {};
  if (!SNAPSHOT_NAME_PATTERN.test(snapshotName)) {
    return res.status(400).json({ error: 'snapshot name contains unsupported characters' });
  }
  if (new_name === undefined && description === undefined) {
    return res.status(400).json({ error: 'new_name or description is required' });
  }
  if (new_name !== undefined && !SNAPSHOT_NAME_PATTERN.test(new_name)) {
    return res.status(400).json({ error: 'new_name contains unsupported characters' });
  }
  if (description !== undefined && typeof description !== 'string') {
    return res.status(400).json({ error: 'description must be a string' });
  }
  return queueSnapshotTask(
    req,
    res,
    'snapshot_modify',
    { snapshot_name: snapshotName, new_name, description },
    'Snapshot modify task queued successfully'
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
