import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import { validateZoneCreationResources } from '../../lib/ResourceValidation.js';
import config from '../../config/ConfigLoader.js';
import { resolveZoneName, createZoneCreationSubTasks } from './ZoneCreationHelpers.js';

/**
 * @fileoverview Zone clone controller - clone zones via ZFS snapshots
 */

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
 * Create ZFS snapshots for cloning
 * @param {Object} sourceZone - Source zone DB record
 * @returns {Promise<{bootDataset: string, bootSnapshotName: string, additionalSnapshots: Array}>}
 */
const createCloneSnapshots = async sourceZone => {
  let zoneConfig = sourceZone.configuration;
  if (typeof zoneConfig === 'string') {
    zoneConfig = JSON.parse(zoneConfig);
  }

  // Identify boot dataset
  let bootDataset = null;
  if (zoneConfig.disks && zoneConfig.disks.boot && zoneConfig.disks.boot.dataset) {
    // Hosts.yml format
    const disk = zoneConfig.disks.boot;
    bootDataset = `${disk.pool}/${disk.dataset}/${disk.volume_name}`;
  } else if (zoneConfig.bootdisk) {
    // zadm format
    bootDataset = zoneConfig.bootdisk.path;
  }

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
  if (zoneConfig.disks && zoneConfig.disks.additional) {
    const snapResults = await Promise.all(
      zoneConfig.disks.additional.map(async disk => {
        const dataset = `${disk.pool}/${disk.dataset}/${disk.volume_name}`;
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
  }

  return { bootDataset, bootSnapshotName: snapshotName, additionalSnapshots };
};

/**
 * Build clone metadata (Hosts.yml structure)
 * @param {Object} sourceZone - Source zone DB record
 * @param {Object} requestBody - Clone request body
 * @param {Object} snapshotInfo - Snapshot info from createCloneSnapshots
 * @param {string} newZoneName - New zone base name
 * @returns {Promise<Object>} Clone metadata
 */
const buildCloneMetadata = async (sourceZone, requestBody, snapshotInfo, newZoneName) => {
  let sourceConfig = sourceZone.configuration;
  if (typeof sourceConfig === 'string') {
    sourceConfig = JSON.parse(sourceConfig);
  }

  // 1. Settings
  const settings = {
    ...sourceConfig.settings,
    hostname: requestBody.settings.hostname,
    domain: requestBody.settings.domain || sourceConfig.settings.domain,
    server_id: requestBody.settings.server_id,
  };

  // Apply overrides
  if (requestBody.overrides) {
    if (requestBody.overrides.memory) {
      settings.memory = requestBody.overrides.memory;
    }
    if (requestBody.overrides.vcpus) {
      settings.vcpus = requestBody.overrides.vcpus;
    }
  }

  // Remove consoleport to avoid conflict
  delete settings.consoleport;

  // 2. Disks
  const disks = {
    boot: {
      ...sourceConfig.disks.boot,
      source: {
        type: 'template',
        template_dataset: snapshotInfo.bootDataset,
        snapshot_name: snapshotInfo.bootSnapshotName,
        clone_strategy: requestBody.clone_strategy || 'clone',
      },
    },
    additional: (sourceConfig.disks && sourceConfig.disks.additional
      ? sourceConfig.disks.additional
      : []
    ).map(disk => {
      const dataset = `${disk.pool}/${disk.dataset}/${disk.volume_name}`;
      const snap = snapshotInfo.additionalSnapshots.find(s => s.dataset === dataset);

      if (snap) {
        return {
          ...disk,
          source: {
            type: 'template',
            template_dataset: dataset,
            snapshot_name: snap.snapshotName,
            clone_strategy: requestBody.clone_strategy || 'clone',
          },
        };
      }
      return { ...disk };
    }),
  };

  // 3. Networks - batch-allocate provisioning IPs (no await-in-loop)
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

  // 4. NICs - Strip physical names and MACs to force auto-generation
  const nics = (sourceConfig.nics || []).map(nic => {
    const nicCopy = { ...nic };
    delete nicCopy.physical;
    delete nicCopy.mac_addr;
    return nicCopy;
  });

  return {
    settings,
    zones: sourceConfig.zones,
    networks,
    disks,
    nics,
    cloud_init: sourceConfig.cloud_init,
    name: newZoneName,
  };
};

/**
 * @swagger
 * /machines/{machineName}/clone:
 *   post:
 *     summary: Clone a machine
 *     description: Creates a copy of an existing machine (zone) using ZFS snapshots and clones.
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
 *               settings:
 *                 type: object
 *                 required: [hostname, server_id]
 *                 properties:
 *                   hostname:
 *                     type: string
 *                   domain:
 *                     type: string
 *                   server_id:
 *                     type: string
 *               clone_strategy:
 *                 type: string
 *                 enum: [clone, copy]
 *                 default: clone
 *               start_after_create:
 *                 type: boolean
 *                 default: false
 *               reprovision:
 *                 type: boolean
 *                 default: false
 *               overrides:
 *                 type: object
 *                 properties:
 *                   memory:
 *                     type: string
 *                   vcpus:
 *                     integer: string
 *     responses:
 *       202:
 *         description: Clone task queued
 */
export const cloneZone = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;
    const { settings, start_after_create = false, reprovision = false } = req.body;

    if (!settings || !settings.hostname || !settings.server_id) {
      return res
        .status(400)
        .json({ error: 'settings.hostname and settings.server_id are required' });
    }

    // 1. Fetch source zone
    const sourceZone = await Zones.findOne({ where: { name: zoneName } });
    if (!sourceZone) {
      return res.status(404).json({ error: 'Source zone not found' });
    }

    if (!sourceZone.configuration) {
      return res.status(400).json({ error: 'Source zone has no configuration data' });
    }

    // 2. Resolve new zone name
    // Use domain from source if not provided
    if (!settings.domain) {
      let sourceConfig = sourceZone.configuration;
      if (typeof sourceConfig === 'string') {
        sourceConfig = JSON.parse(sourceConfig);
      }
      if (sourceConfig.settings && sourceConfig.settings.domain) {
        settings.domain = sourceConfig.settings.domain;
      }
    }

    const fullBaseName = `${settings.hostname}.${settings.domain}`;
    const nameResult = await resolveZoneName(fullBaseName, settings);
    if (!nameResult.success) {
      return res.status(nameResult.error.status).json(nameResult.error);
    }
    const { finalZoneName } = nameResult;

    // 3. Check if new zone exists
    const existingZone = await Zones.findOne({ where: { name: finalZoneName } });
    if (existingZone) {
      return res.status(409).json({ error: `Zone ${finalZoneName} already exists` });
    }

    // 4. Create snapshots
    const snapshotInfo = await createCloneSnapshots(sourceZone);

    // 5. Build metadata
    const cloneMetadata = await buildCloneMetadata(
      sourceZone,
      req.body,
      snapshotInfo,
      fullBaseName
    );

    // 6. Validate resources
    const resourceValidation = await validateZoneCreationResources(cloneMetadata);
    if (!resourceValidation.valid) {
      return res.status(400).json({
        error: 'Insufficient resources for clone',
        details: resourceValidation.errors,
      });
    }

    // 7. Create orchestration tasks
    const parentTask = await Tasks.create({
      zone_name: finalZoneName,
      operation: 'zone_clone_orchestration',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      metadata: JSON.stringify(cloneMetadata),
      status: 'pending',
    });

    const { subTasks } = await createZoneCreationSubTasks(
      finalZoneName,
      cloneMetadata,
      parentTask.id,
      null,
      start_after_create,
      req.entity.name
    );

    // 8. Handle reprovisioning (optional)
    if (reprovision) {
      // Logic to queue setup/provision tasks would go here
      // For now, we'll stick to the creation pipeline
    }

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
