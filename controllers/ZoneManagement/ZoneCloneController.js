import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import { validateZoneName } from '../../lib/ZoneValidation.js';
import { validateZoneCreationResources } from '../../lib/ResourceValidation.js';
import config from '../../config/ConfigLoader.js';
import { resolveZoneName, createZoneCreationSubTasks } from './ZoneCreationHelpers.js';
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
 * Batch-allocate provisioning IPs from the configured DHCP range.
 * Performs a single DB query to find all used IPs, then picks `count` unused ones.
 * @param {number} count - Number of IPs to allocate
 * @returns {Promise<string[]>} Array of allocated IP strings
 */
const allocateProvisioningIPs = async count => {
  if (count === 0) {
    return [];
  }

  const provisioningConfig = config.get('provisioning') || {};
  const networkConfig = provisioningConfig.network || {};

  if (!networkConfig.dhcp_range_start || !networkConfig.dhcp_range_end) {
    log.api.warn('Provisioning DHCP range not configured');
    return [];
  }

  const ipToLong = ip =>
    ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;

  const longToIp = long =>
    [(long >>> 24) & 255, (long >>> 16) & 255, (long >>> 8) & 255, long & 255].join('.');

  const start = ipToLong(networkConfig.dhcp_range_start);
  const end = ipToLong(networkConfig.dhcp_range_end);

  // Single DB query to get all used IPs
  const zones = await Zones.findAll();
  const usedIps = new Set();

  zones.forEach(zone => {
    let zoneConfig = zone.configuration;
    if (typeof zoneConfig === 'string') {
      try {
        zoneConfig = JSON.parse(zoneConfig);
      } catch {
        return;
      }
    }

    if (zoneConfig && zoneConfig.networks) {
      zoneConfig.networks.forEach(net => {
        if (net.provisional && net.address) {
          usedIps.add(net.address);
        }
      });
    }
  });

  // Allocate `count` IPs from range, marking each as used for subsequent picks
  const allocated = [];
  for (let i = start; i <= end && allocated.length < count; i++) {
    const ip = longToIp(i);
    if (!usedIps.has(ip)) {
      allocated.push(ip);
      usedIps.add(ip);
    }
  }

  return allocated;
};

/**
 * List the source zone's clonable datasets.
 * @param {Object} zoneConfig - Parsed source configuration
 * @returns {{bootDataset: string|null, additional: string[]}}
 */
const cloneDatasets = zoneConfig => {
  let bootDataset = null;
  if (zoneConfig.disks?.boot?.dataset) {
    // Hosts.yml format
    const disk = zoneConfig.disks.boot;
    bootDataset = `${disk.pool}/${disk.dataset}/${disk.volume_name}`;
  } else if (zoneConfig.bootdisk) {
    // zadm format
    bootDataset = zoneConfig.bootdisk.path;
  }
  const additional = (zoneConfig.disks?.additional || []).map(
    disk => `${disk.pool}/${disk.dataset}/${disk.volume_name}`
  );
  return { bootDataset, additional };
};

/**
 * Resolve a caller-named snapshot against every source dataset — a named
 * clone is one point in time, so a dataset missing the snapshot refuses the
 * whole clone instead of silently mixing states.
 * @param {Object} zoneConfig - Parsed source configuration
 * @param {string} snapshot - Snapshot name to verify
 * @returns {Promise<Object>} Snapshot info or a refusal
 */
const verifyNamedSnapshots = async (zoneConfig, snapshot) => {
  const { bootDataset, additional } = cloneDatasets(zoneConfig);
  if (!bootDataset) {
    return { success: false, error: 'Could not determine boot dataset for source zone' };
  }

  const checks = await Promise.all(
    [bootDataset, ...additional].map(async dataset => ({
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

  return {
    success: true,
    bootDataset,
    bootSnapshotName: snapshot,
    additionalSnapshots: additional.map(dataset => ({ dataset, snapshotName: snapshot })),
  };
};

/**
 * Create fresh ZFS snapshots of the source's current state for cloning.
 * @param {Object} zoneConfig - Parsed source configuration
 * @returns {Promise<{bootDataset: string, bootSnapshotName: string, additionalSnapshots: Array}>}
 */
const createCloneSnapshots = async zoneConfig => {
  const { bootDataset, additional } = cloneDatasets(zoneConfig);
  if (!bootDataset) {
    throw new Error('Could not determine boot dataset for source zone');
  }

  const timestamp = Date.now();
  const snapshotName = `clone_${timestamp}`;
  const additionalSnapshots = [];

  // Snapshot boot disk
  log.api.info(`Creating snapshot for clone: ${bootDataset}@${snapshotName}`);
  const bootSnapResult = await executeCommand(`pfexec zfs snapshot ${bootDataset}@${snapshotName}`);
  if (!bootSnapResult.success) {
    throw new Error(`Failed to snapshot boot dataset: ${bootSnapResult.error}`);
  }

  // Handle additional disks in parallel
  const snapResults = await Promise.all(
    additional.map(async dataset => {
      const snapResult = await executeCommand(`pfexec zfs snapshot ${dataset}@${snapshotName}`);
      return { dataset, snapshotName, success: snapResult.success, error: snapResult.error };
    })
  );

  snapResults.forEach(result => {
    if (result.success) {
      additionalSnapshots.push({ dataset: result.dataset, snapshotName: result.snapshotName });
    } else {
      log.api.warn(`Failed to snapshot additional disk ${result.dataset}`, {
        error: result.error,
      });
    }
  });

  return { bootDataset, bootSnapshotName: snapshotName, additionalSnapshots };
};

/**
 * Build the clone's create-orchestration metadata (Hosts.yml structure).
 * Identity never copies: MACs, VNIC names, and non-provisional addressing
 * strip; provisional networks get a fresh provisioning-range address.
 * @param {Object} sourceConfig - Parsed source configuration
 * @param {Object} mergedSettings - Source settings with caller settings/overrides merged
 * @param {Object|null} snapshotInfo - Snapshot info for source "current", null for "template"
 * @param {string} cloneStrategy - 'clone' (thin) or 'copy' (full send/recv)
 * @param {string} metadataName - Base name the task executors read
 * @returns {Promise<Object>} Clone metadata
 */
const buildCloneMetadata = async (
  sourceConfig,
  mergedSettings,
  snapshotInfo,
  cloneStrategy,
  metadataName
) => {
  // Disks: source "current" points every disk at its snapshot; source
  // "template" rides the stored creation layout verbatim (fresh build).
  const disks = snapshotInfo
    ? {
        boot: {
          ...sourceConfig.disks?.boot,
          source: {
            type: 'template',
            template_dataset: snapshotInfo.bootDataset,
            snapshot_name: snapshotInfo.bootSnapshotName,
            clone_strategy: cloneStrategy,
          },
        },
        additional: (sourceConfig.disks?.additional || []).map(disk => {
          const dataset = `${disk.pool}/${disk.dataset}/${disk.volume_name}`;
          const snap = snapshotInfo.additionalSnapshots.find(s => s.dataset === dataset);

          if (snap) {
            return {
              ...disk,
              source: {
                type: 'template',
                template_dataset: dataset,
                snapshot_name: snap.snapshotName,
                clone_strategy: cloneStrategy,
              },
            };
          }
          return { ...disk };
        }),
      }
    : sourceConfig.disks;

  // Networks - batch-allocate provisioning IPs (no await-in-loop)
  const sourceNetworks = sourceConfig.networks || [];
  const provisionalCount = sourceNetworks.filter(net => net.provisional).length;
  const allocatedIps = await allocateProvisioningIPs(provisionalCount);

  let ipIndex = 0;
  const networks = sourceNetworks.map(net => {
    if (net.provisional) {
      const ip = allocatedIps[ipIndex] || '';
      ipIndex += 1;
      return { ...net, address: ip };
    }
    // Strip IP info for non-provisional networks
    const netCopy = { ...net };
    delete netCopy.address;
    delete netCopy.gateway;
    delete netCopy.dns;
    delete netCopy.netmask;
    return netCopy;
  });

  // NICs - Strip physical names and MACs to force auto-generation
  const nics = (sourceConfig.nics || []).map(nic => {
    const nicCopy = { ...nic };
    delete nicCopy.physical;
    delete nicCopy.mac_addr;
    return nicCopy;
  });

  return {
    settings: mergedSettings,
    zones: sourceConfig.zones,
    networks,
    disks,
    nics,
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
 * Settle the clone's disk sources per flavor: source "current" snapshots (or
 * verifies the named snapshot on) every source dataset; source "template"
 * rides the stored creation layout.
 * @param {string} source - Clone flavor
 * @param {string} snapshot - Named snapshot ('' for fresh)
 * @param {Object} sourceConfig - Parsed source configuration
 * @returns {Promise<{snapshotInfo?: Object|null, refusal?: Object}>}
 */
const resolveCloneDiskSources = async (source, snapshot, sourceConfig) => {
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
  if (!snapshot) {
    return { snapshotInfo: await createCloneSnapshots(sourceConfig) };
  }
  const named = await verifyNamedSnapshots(sourceConfig, snapshot);
  if (!named.success) {
    const refusal = { error: named.error };
    if (named.missing_datasets) {
      refusal.missing_datasets = named.missing_datasets;
    }
    return { refusal };
  }
  return { snapshotInfo: named };
};

/**
 * @swagger
 * /machines/{machineName}/clone:
 *   post:
 *     summary: Clone a machine
 *     description: |
 *       Clones a machine through the create orchestration (the Go agent's clone
 *       wire). `source` "current" (default) copies today's disk state: every
 *       source dataset is snapshotted — or the named `snapshot` is used — and
 *       the clone's disks build from those snapshots (`linked` true = thin ZFS
 *       CoW clone, false = full copy via zfs send/recv). `source` "template"
 *       rebuilds fresh disks from the stored creation config instead. Identity
 *       never copies: server_id, consoleport, MACs, VNIC names, and
 *       non-provisional addressing strip; provisional networks get a fresh
 *       provisioning-range address.
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
    const diskSources = await resolveCloneDiskSources(source, snapshot, sourceConfig);
    if (diskSources.refusal) {
      return res.status(400).json(diskSources.refusal);
    }

    // 6. Build metadata
    const cloneMetadata = await buildCloneMetadata(
      sourceConfig,
      mergedSettings,
      diskSources.snapshotInfo,
      linked ? 'clone' : 'copy',
      explicitName || `${mergedSettings.hostname}.${mergedSettings.domain}`
    );

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
