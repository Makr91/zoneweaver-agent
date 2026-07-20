import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import { validateZoneCreationResources } from '../../lib/ResourceValidation.js';
import { ensureProvisioningNetwork } from '../ProvisioningNetworkController.js';
import { createZoneCreationSubTasks, prepareNetworkSections } from './ZoneCreationHelpers.js';
import { findExistingZoneConflict } from './ZoneCreationController.js';
import {
  parseConfiguration,
  buildCloneMetadata,
  validateCloneRequest,
  resolveCloneName,
  resolveCloneDiskSources,
} from './ZoneCloneHelpers.js';

/**
 * @fileoverview Zone clone controller — the Go agent's clone wire on honest
 * ZFS semantics. source "current" (default) clones today's disk state through
 * ZFS snapshots (linked true = thin CoW clone, false = full zfs send/recv
 * copy; a named snapshot clones that point in time); source "template"
 * rebuilds fresh disks from the stored creation config. Either flavor runs
 * the normal create orchestration — a clone builds real infrastructure.
 */

/**
 * @swagger
 * /machines/{machineName}/clone:
 *   post:
 *     summary: Clone a machine
 *     description: |
 *       Clones a machine through the create orchestration (the Go agent's clone
 *       wire, the Proxmox model): a clone carries the source's DATA on EVERY
 *       disk — nothing comes out empty. `source` "current" (default) snapshots
 *       every source dataset under one name — or verifies the named
 *       `snapshot_name` on every one — and each of the clone's disks builds
 *       from its snapshot (`linked` true = thin ZFS CoW clone, false = full
 *       copy via zfs send/recv). Image-attached disks (foreign zvols) ALWAYS
 *       full-copy regardless of `linked` — the copy makes the clone independent
 *       of the foreign original and becomes the clone's own stamped zvol; the
 *       clone_<ts> snapshot our copy read from remains on the source datasets.
 *       `source` "template" is the explicit opt-in REBUILD flavor — fresh disks
 *       from the stored creation config, no data copy. The networking SHAPE
 *       rides (bridge/vlan/type/netmask/gateway/dns; the zonecfg nic half
 *       derives from it); identity never copies: server_id, consoleport, MACs
 *       (fresh auto), VNIC names, and static addresses strip; a provisional
 *       entry clones as dhcp4 with NO address — the agent's dhcpd leases fresh
 *       on first boot.
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
 *             required: [settings]
 *             properties:
 *               name:
 *                 type: string
 *                 description: Explicit clone name — wins over the derived hostname.domain name
 *               settings:
 *                 type: object
 *                 required: [hostname]
 *                 description: |
 *                   Settings merged over the source machine's settings — hostname is
 *                   required (a clone must not reuse the source hostname); domain
 *                   defaults to the source's; server_id is required only when
 *                   prefix_zone_names is enabled.
 *                 properties:
 *                   hostname:
 *                     type: string
 *                   domain:
 *                     type: string
 *                   server_id:
 *                     type: string
 *               overrides:
 *                 type: object
 *                 description: Settings overrides merged last (e.g. memory, vcpus)
 *               source:
 *                 type: string
 *                 enum: [current, template]
 *                 default: current
 *                 description: |
 *                   current = clone today's disk state via ZFS snapshots;
 *                   template = rebuild fresh disks from the stored creation config.
 *               snapshot_name:
 *                 type: string
 *                 description: |
 *                   Named source snapshot to clone from (source "current" only) —
 *                   must exist on every source dataset. Omit for a fresh snapshot
 *                   of the current state. (Same key as export/publish.)
 *               linked:
 *                 type: boolean
 *                 default: true
 *                 description: |
 *                   true = thin ZFS CoW clone (natural on ZFS); false = full
 *                   independent copy via zfs send/recv.
 *               start_after_create:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       202:
 *         description: Clone orchestration queued
 *       400:
 *         description: Invalid parameters or missing snapshot/disk layout
 *       404:
 *         description: Source zone not found
 *       409:
 *         description: Clone name already exists
 */
export const cloneZone = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;
    const settings = req.body.settings || {};
    const overrides = req.body.overrides || {};
    const {
      name: explicitName,
      source = 'current',
      snapshot_name: snapshot = '',
      linked = true,
      start_after_create = false,
    } = req.body;

    const requestProblem = validateCloneRequest(source, settings, snapshot);
    if (requestProblem) {
      return res.status(400).json(requestProblem);
    }

    const sourceZone = await Zones.findOne({ where: { name: zoneName } });
    if (!sourceZone) {
      return res.status(404).json({ error: 'Source zone not found' });
    }
    if (!sourceZone.configuration) {
      return res.status(400).json({ error: 'Source zone has no configuration data' });
    }
    const sourceConfig = parseConfiguration(sourceZone);

    const mergedSettings = { ...sourceConfig.settings };
    delete mergedSettings.server_id;
    delete mergedSettings.consoleport;
    Object.assign(mergedSettings, settings, overrides);

    const named = await resolveCloneName(explicitName, mergedSettings);
    if (named.error) {
      return res.status(named.error.status).json(named.error.body);
    }
    const { finalZoneName } = named;

    const conflict = await findExistingZoneConflict(finalZoneName);
    if (conflict) {
      return res.status(409).json(conflict);
    }

    const diskSources = await resolveCloneDiskSources(source, snapshot, sourceConfig, zoneName);
    if (diskSources.refusal) {
      return res.status(400).json(diskSources.refusal);
    }

    const cloneMetadata = buildCloneMetadata(
      sourceConfig,
      mergedSettings,
      diskSources.snapshotInfo,
      linked ? 'clone' : 'copy',
      explicitName || `${mergedSettings.hostname}.${mergedSettings.domain}`
    );
    prepareNetworkSections(cloneMetadata);

    const resourceValidation = await validateZoneCreationResources(cloneMetadata);
    if (!resourceValidation.valid) {
      return res.status(400).json({
        error: 'Insufficient resources for clone',
        details: resourceValidation.errors,
      });
    }

    const networkSetup = cloneMetadata.provisioner_ref
      ? await ensureProvisioningNetwork(req.entity.name)
      : null;

    const parentTask = await Tasks.create({
      zone_name: finalZoneName,
      operation: 'zone_clone_orchestration',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      metadata: JSON.stringify(cloneMetadata),
      status: 'running',
      started_at: new Date(),
    });

    const { subTasks } = await createZoneCreationSubTasks(
      finalZoneName,
      cloneMetadata,
      parentTask.id,
      networkSetup?.lastTaskId ?? null,
      start_after_create,
      req.entity.name
    );
    if (networkSetup) {
      subTasks.network_setup = networkSetup.parentTaskId;
    }

    log.api.info('Zone clone queued', {
      source_machine: zoneName,
      clone: finalZoneName,
      clone_source: source,
      snapshot: snapshot || null,
      linked,
      created_by: req.entity.name,
    });

    return res.status(202).json({
      success: true,
      parent_task_id: parentTask.id,
      machine_name: finalZoneName,
      source_machine: zoneName,
      operation: 'zone_clone_orchestration',
      status: 'pending',
      message: 'Zone clone queued',
      sub_tasks: subTasks,
    });
  } catch (error) {
    log.api.error('Error cloning zone', { error: error.message, stack: error.stack });
    return res.status(500).json({ error: 'Failed to clone zone', details: error.message });
  }
};
