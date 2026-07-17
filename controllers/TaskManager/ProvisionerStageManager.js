/**
 * @fileoverview Provisioner package staging executor (zone_provisioning_stage task)
 * @description Lands a registry package version onto a zone's provisioning dataset —
 * the working-copy analog of the artifact extract path: create the dataset, rsync the
 * package tree in, write the machine's Hosts.yml (reconstructed from the stored
 * document sections), fix ownership and key permissions, snapshot.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import { updateTaskProgress, parseTaskMetadata } from '../../lib/TaskProgressHelper.js';
import { parseConfiguration } from '../../lib/ZoneConfigUtils.js';
import { getPackageVersion } from '../../lib/ProvisionerRegistry.js';
import {
  ensureProvisioningDataset,
  fixProvisioningKeyPermissions,
} from './ZoneProvisionManager.js';
import Zones from '../../models/ZoneModel.js';

const buildHostsYml = zoneConfig => {
  const host = {
    settings: zoneConfig.settings || {},
    networks: zoneConfig.networks || [],
  };
  if (zoneConfig.disks) {
    host.disks = zoneConfig.disks;
  }
  if (zoneConfig.zones) {
    host.zones = zoneConfig.zones;
  }
  if (zoneConfig.provisioner && typeof zoneConfig.provisioner === 'object') {
    for (const [key, value] of Object.entries(zoneConfig.provisioner)) {
      host[key] = value;
    }
  }
  return yaml.dump({ hosts: [host] });
};

export const executeZoneProvisioningStageTask = async task => {
  const { zone_name } = task;

  try {
    const metadata = await parseTaskMetadata(task);
    const { provisioner_name, provisioner_version, dataset_path } = metadata;
    const { onData } = task;

    const pkg = getPackageVersion(provisioner_name, provisioner_version);
    if (!pkg) {
      return {
        success: false,
        error: `Provisioner ${provisioner_name}/${provisioner_version} is not in the registry`,
      };
    }

    const zone = await Zones.findOne({ where: { name: zone_name } });
    if (!zone) {
      return { success: false, error: `Zone '${zone_name}' not found` };
    }
    const zoneConfig = parseConfiguration(zone);

    await updateTaskProgress(task, 10, { status: 'creating_dataset' });
    const ensured = await ensureProvisioningDataset(dataset_path, onData);
    if (!ensured.success) {
      return ensured;
    }

    await updateTaskProgress(task, 30, { status: 'staging_package' });
    const syncResult = await executeCommand(
      `pfexec rsync -a --exclude=.git "${pkg.root}/" "${dataset_path}/"`,
      600000,
      onData
    );
    if (!syncResult.success) {
      return { success: false, error: `Package staging failed: ${syncResult.error}` };
    }

    await updateTaskProgress(task, 70, { status: 'writing_document' });
    await executeCommand(`pfexec chown -R zwagent:other ${dataset_path}`, undefined, onData);
    fs.writeFileSync(path.join(dataset_path, 'Hosts.yml'), buildHostsYml(zoneConfig), {
      mode: 0o600,
    });

    await fixProvisioningKeyPermissions(dataset_path, onData);

    await updateTaskProgress(task, 90, { status: 'snapshotting' });
    await executeCommand(
      `pfexec zfs snapshot ${ensured.zfsDataset}@pre-provision`,
      undefined,
      onData
    );

    await updateTaskProgress(task, 100, { status: 'completed' });
    return {
      success: true,
      message: `Provisioner ${provisioner_name}/${provisioner_version} staged to ${dataset_path}`,
    };
  } catch (error) {
    log.task.error('Provisioner staging failed', { zone_name, error: error.message });
    return { success: false, error: `Provisioner staging failed: ${error.message}` };
  }
};
