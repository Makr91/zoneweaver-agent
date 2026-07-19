import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import { validateZoneName } from '../../lib/ZoneValidation.js';
import { validateZoneCreationResources } from '../../lib/ResourceValidation.js';
import { buildDatasetPath } from '../TaskManager/ZoneCreationManager/utils/ConfigBuilders.js';
import {
  resolveZoneName,
  createZoneCreationSubTasks,
  prepareNetworkSections,
} from './ZoneCreationHelpers.js';
import { findExistingZoneConflict } from './ZoneCreationController.js';

/**
 * @fileoverview Zone clone controller — the Go agent's clone wire on honest
 * ZFS semantics. source "current" (default) clones today's disk state through
 * ZFS snapshots (linked true = thin CoW clone, false = full zfs send/recv
 * copy; a named snapshot clones that point in time); source "template"
 * rebuilds fresh disks from the stored creation config. Either flavor runs
 * the normal create orchestration — a clone builds real infrastructure.
 */

/**
 * ZFS snapshot-component charset — the snapshot body rides into zfs
 * commands, so nothing outside it is accepted.
 */
const SNAPSHOT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

/**
 * Parse a zone row's configuration column (JSON string or object).
 * @param {Object} zone - Zone DB record
 * @returns {Object} Parsed configuration
 */
const parseConfiguration = zone => {
  let zoneConfig = zone.configuration;
  if (typeof zoneConfig === 'string') {
    zoneConfig = JSON.parse(zoneConfig);
  }
  return zoneConfig;
};

/**
 * Enumerate every source dataset whose DATA the clone copies (Mark's
 * ruling: a clone carries the source's data on every disk — nothing comes
 * out empty). Boot resolves through the same typed defaults +
 * server_id-prefixed path construction the create path materializes with
 * (buildDatasetPath), zadm-format documents falling back to the bootdisk
 * attr; each additional disk resolves via its typed path (blank) or its
 * attached path (image — the foreign zvol whose data copies; the original
 * is never modified beyond our snapshot).
 * @param {Object} zoneConfig - Parsed source configuration
 * @param {string} zoneName - Source zone name
 * @returns {{bootDataset: string|null, additional: Array<{index: number, dataset: string, entry: Object}>}}
 */
const cloneSourceDatasets = (zoneConfig, zoneName) => {
  const serverId = zoneConfig.settings?.server_id ? String(zoneConfig.settings.server_id) : '';
  const boot = zoneConfig.disks?.boot;
  let bootDataset = null;
  if (boot) {
    const pool = boot.pool || 'rpool';
    const dataset = boot.dataset || 'zones';
    const volumeName = boot.volume_name || 'boot';
    bootDataset = `${buildDatasetPath(`${pool}/${dataset}`, zoneName, serverId)}/${volumeName}`;
  } else if (zoneConfig.bootdisk) {
    bootDataset = zoneConfig.bootdisk.path;
  }
  const additional = (zoneConfig.disks?.additional_disks || []).map((entry, index) => {
    if (entry?.type === 'image') {
      return { index, dataset: entry.path, entry };
    }
    const pool = entry.pool || 'rpool';
    const dataset = entry.dataset || 'zones';
    const volumeName = entry.volume_name || `disk${index}`;
    return {
      index,
      dataset: `${buildDatasetPath(`${pool}/${dataset}`, zoneName, serverId)}/${volumeName}`,
      entry,
    };
  });
  return { bootDataset, additional };
};

/**
 * Resolve a caller-named snapshot against EVERY source dataset — one point
 * in time; a dataset missing the snapshot refuses the whole clone instead
 * of silently mixing states.
 * @param {Object} sources - cloneSourceDatasets result
 * @param {string} snapshot - Snapshot name to verify
 * @returns {Promise<Object>} {success, snapshotName} or a refusal
 */
const verifyNamedSnapshots = async (sources, snapshot) => {
  const datasets = [sources.bootDataset, ...sources.additional.map(a => a.dataset)];
  const checks = await Promise.all(
    datasets.map(async dataset => ({
      dataset,
      exists: (await executeCommand(`pfexec zfs list -H -o name ${dataset}@${snapshot}`)).success,
    }))
  );
  const missing = checks.filter(check => !check.exists).map(check => check.dataset);
  if (missing.length > 0) {
    return {
      success: false,
      error: `Snapshot ${snapshot} does not exist on every source dataset`,
      missing_datasets: missing,
    };
  }
  return { success: true, snapshotName: snapshot };
};

/**
 * Snapshot EVERY source dataset's current state under one name — one point
 * in time. Any failure destroys the snapshots that did land (best effort)
 * and refuses the clone; a partial set never survives.
 * @param {Object} sources - cloneSourceDatasets result
 * @returns {Promise<{snapshotName: string}>}
 */
const createCloneSnapshots = async sources => {
  const snapshotName = `clone_${Date.now()}`;
  const datasets = [sources.bootDataset, ...sources.additional.map(a => a.dataset)];
  log.api.info('Creating clone snapshots', { snapshot: snapshotName, datasets });
  const results = await Promise.all(
    datasets.map(async dataset => ({
      dataset,
      result: await executeCommand(`pfexec zfs snapshot ${dataset}@${snapshotName}`),
    }))
  );
  const failed = results.filter(({ result }) => !result.success);
  if (failed.length > 0) {
    await Promise.all(
      results
        .filter(({ result }) => result.success)
        .map(({ dataset }) => executeCommand(`pfexec zfs destroy ${dataset}@${snapshotName}`))
    );
    throw new Error(
      `Failed to snapshot ${failed.map(f => f.dataset).join(', ')}: ${failed[0].result.error}`
    );
  }
  return { snapshotName };
};

/**
 * Build the clone's create-orchestration metadata (Hosts.yml structure,
 * Mark's ruling: a clone carries the source's DATA on EVERY disk). The
 * networking SHAPE rides (bridge/vlan/type/netmask/gateway/dns), identity
 * never copies — static addresses strip, MACs go auto, a provisional entry
 * clones as dhcp4 with NO address (the agent's dhcpd leases fresh on first
 * boot). Every disk enriches with the typed template keys the executors
 * actually read: boot + blank-declared additional disks per the caller's
 * clone_strategy; image-sourced disks ALWAYS full-copy (a thin clone would
 * chain the new machine to a snapshot on a foreign dataset) and become the
 * clone's OWN stamped zvol.
 * @param {Object} sourceConfig - Parsed source configuration
 * @param {Object} mergedSettings - Source settings with caller settings/overrides merged
 * @param {Object|null} snapshotInfo - {snapshotName, sources} for source "current", null for "template"
 * @param {string} cloneStrategy - 'clone' (thin) or 'copy' (full send/recv)
 * @param {string} metadataName - Base name the task executors read
 * @returns {Object} Clone metadata
 */
const buildCloneMetadata = (
  sourceConfig,
  mergedSettings,
  snapshotInfo,
  cloneStrategy,
  metadataName
) => {
  const disks = snapshotInfo
    ? {
        ...sourceConfig.disks,
        boot: {
          ...sourceConfig.disks?.boot,
          type: 'template',
          template_dataset: snapshotInfo.sources.bootDataset,
          snapshot_name: snapshotInfo.snapshotName,
          clone_strategy: cloneStrategy,
          provenance: 'clone',
        },
        additional_disks: snapshotInfo.sources.additional.map(({ index, dataset, entry }) => {
          const base = entry.type === 'image' ? { volume_name: `disk${index}` } : { ...entry };
          delete base.path;
          delete base.force;
          return {
            ...base,
            type: 'template',
            template_dataset: dataset,
            snapshot_name: snapshotInfo.snapshotName,
            clone_strategy: entry.type === 'image' ? 'copy' : cloneStrategy,
            provenance: 'clone',
          };
        }),
      }
    : sourceConfig.disks;

  const networks = (sourceConfig.networks || []).map(net => {
    const netCopy = { ...net };
    delete netCopy.address;
    if (netCopy.mac) {
      netCopy.mac = 'auto';
    }
    if (netCopy.provisional === true) {
      netCopy.dhcp4 = true;
    }
    return netCopy;
  });

  return {
    settings: mergedSettings,
    zones: sourceConfig.zones,
    networks,
    disks,
    cloud_init: sourceConfig.cloud_init,
    provisioner: sourceConfig.provisioner,
    provisioner_ref: sourceConfig.provisioner_ref,
    name: metadataName,
  };
};

/**
 * Validate the clone request's own fields (source flavor, hostname rule,
 * snapshot charset). Null when usable.
 * @param {string} source - Clone flavor
 * @param {Object} settings - Caller settings
 * @param {string} snapshot - Named snapshot ('' for fresh)
 * @returns {Object|null} 400 body or null
 */
const validateCloneRequest = (source, settings, snapshot) => {
  if (!['current', 'template'].includes(source)) {
    return {
      error:
        'source must be "current" (clone today\'s disk state via ZFS snapshots) or "template" (rebuild from the stored creation config)',
    };
  }
  if (!settings.hostname) {
    return {
      error: 'settings.hostname is required — a clone must not reuse the source hostname',
    };
  }
  if (snapshot && !SNAPSHOT_NAME_PATTERN.test(snapshot)) {
    return { error: 'snapshot is not a usable ZFS snapshot name' };
  }
  return null;
};

/**
 * Resolve the clone's name — an explicit name wins verbatim; otherwise
 * hostname.domain through the server_id prefix rule.
 * @param {string|undefined} explicitName - Caller-provided name
 * @param {Object} mergedSettings - Merged clone settings
 * @returns {Promise<{finalZoneName?: string, error?: {status: number, body: Object}}>}
 */
const resolveCloneName = async (explicitName, mergedSettings) => {
  if (explicitName) {
    if (!validateZoneName(explicitName)) {
      return { error: { status: 400, body: { error: 'Invalid machine name' } } };
    }
    return { finalZoneName: explicitName };
  }
  const baseName = `${mergedSettings.hostname}.${mergedSettings.domain}`;
  if (!mergedSettings.domain || !validateZoneName(baseName)) {
    return {
      error: {
        status: 400,
        body: {
          error: `Derived machine name ${baseName} is not usable — provide an explicit name`,
        },
      },
    };
  }
  const nameResult = await resolveZoneName(baseName, mergedSettings);
  if (!nameResult.success) {
    return { error: { status: nameResult.error.status, body: nameResult.error } };
  }
  return { finalZoneName: nameResult.finalZoneName };
};

/**
 * Settle the clone's disk sources per flavor: source "current" snapshots
 * (or verifies the named snapshot on) EVERY source dataset — boot and
 * additional alike; source "template" rides the stored creation layout.
 * @param {string} source - Clone flavor
 * @param {string} snapshot - Named snapshot ('' for fresh)
 * @param {Object} sourceConfig - Parsed source configuration
 * @param {string} zoneName - Source zone name
 * @returns {Promise<{snapshotInfo?: Object|null, refusal?: Object}>}
 */
const resolveCloneDiskSources = async (source, snapshot, sourceConfig, zoneName) => {
  if (source !== 'current') {
    if (!sourceConfig.disks?.boot) {
      return {
        refusal: {
          error:
            'Source machine has no stored creation disk layout — clone with source "current" instead',
        },
      };
    }
    return { snapshotInfo: null };
  }
  const sources = cloneSourceDatasets(sourceConfig, zoneName);
  if (!sources.bootDataset) {
    return { refusal: { error: 'Could not determine boot dataset for source zone' } };
  }
  if (!snapshot) {
    const created = await createCloneSnapshots(sources);
    return { snapshotInfo: { snapshotName: created.snapshotName, sources } };
  }
  const named = await verifyNamedSnapshots(sources, snapshot);
  if (!named.success) {
    const refusal = { error: named.error };
    if (named.missing_datasets) {
      refusal.missing_datasets = named.missing_datasets;
    }
    return { refusal };
  }
  return { snapshotInfo: { snapshotName: named.snapshotName, sources } };
};

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

    // 1. Fetch source zone
    const sourceZone = await Zones.findOne({ where: { name: zoneName } });
    if (!sourceZone) {
      return res.status(404).json({ error: 'Source zone not found' });
    }
    if (!sourceZone.configuration) {
      return res.status(400).json({ error: 'Source zone has no configuration data' });
    }
    const sourceConfig = parseConfiguration(sourceZone);

    // 2. Merge identity: source settings (server_id/consoleport stripped) ←
    // caller settings ← overrides (the Go clone's merge order).
    const mergedSettings = { ...sourceConfig.settings };
    delete mergedSettings.server_id;
    delete mergedSettings.consoleport;
    Object.assign(mergedSettings, settings, overrides);

    // 3. Resolve the clone's name — an explicit name wins verbatim.
    const named = await resolveCloneName(explicitName, mergedSettings);
    if (named.error) {
      return res.status(named.error.status).json(named.error.body);
    }
    const { finalZoneName } = named;

    // 4. 409 against the DB and the system
    const conflict = await findExistingZoneConflict(finalZoneName);
    if (conflict) {
      return res.status(409).json(conflict);
    }

    // 5. Disk sources per clone flavor
    const diskSources = await resolveCloneDiskSources(source, snapshot, sourceConfig, zoneName);
    if (diskSources.refusal) {
      return res.status(400).json(diskSources.refusal);
    }

    // 6. Build metadata, then the shared network preparation (transport
    // attach when packaged + dns declare + the nic-half derivation).
    const cloneMetadata = buildCloneMetadata(
      sourceConfig,
      mergedSettings,
      diskSources.snapshotInfo,
      linked ? 'clone' : 'copy',
      explicitName || `${mergedSettings.hostname}.${mergedSettings.domain}`
    );
    prepareNetworkSections(cloneMetadata);

    // 7. Validate resources
    const resourceValidation = await validateZoneCreationResources(cloneMetadata);
    if (!resourceValidation.valid) {
      return res.status(400).json({
        error: 'Insufficient resources for clone',
        details: resourceValidation.errors,
      });
    }

    // 8. Create orchestration tasks. The clone parent is a pure anchor:
    // born running, never dispatched; the child rollup drives its state.
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
      null,
      start_after_create,
      req.entity.name
    );

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
