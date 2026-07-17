import fs from 'fs';
import path from 'path';
import { executeCommand } from '../../../../lib/CommandManager.js';
import { getZoneConfig } from '../../../../lib/ZoneConfigUtils.js';
import { calculateChecksum } from '../../../../lib/ChecksumHelper.js';
import { updateTaskProgress } from './ProgressHelper.js';

/**
 * @fileoverview Box artifact creation utilities for template export
 */

/**
 * Helper to identify boot dataset from zone config
 * @param {Object} zoneConfig - Zone configuration object
 * @returns {Promise<string>} Boot dataset path
 */
const getZoneBootDataset = async zoneConfig => {
  let dataset = null;
  if (zoneConfig.brand === 'bhyve') {
    // For bhyve, use the bootdisk object from zadm output
    if (zoneConfig.bootdisk && zoneConfig.bootdisk.path) {
      dataset = zoneConfig.bootdisk.path;
    } else if (zoneConfig.attr?.find(a => a.name === 'bootdisk')) {
      // Fallback for older configs
      dataset = zoneConfig.attr.find(a => a.name === 'bootdisk').value;
    }

    if (!dataset) {
      throw new Error('Could not determine bootdisk for bhyve zone');
    }
  } else {
    // For native zones (ipkg/lipkg), use the zonepath dataset
    const { zonepath } = zoneConfig;
    if (!zonepath) {
      throw new Error('Zone has no zonepath');
    }

    const zfsResult = await executeCommand(`pfexec zfs list -H -o name "${zonepath}"`);
    if (zfsResult.success) {
      dataset = zfsResult.output.trim();
    } else {
      throw new Error(`Failed to resolve dataset for zonepath ${zonepath}`);
    }
  }
  return dataset;
};

/**
 * Helper to generate metadata files for box artifact
 * @param {string} tempDir - Temporary directory
 * @param {Object} zoneConfig - Zone configuration
 * @param {string} zoneName - Zone name
 */
const generateBoxMetadata = async (tempDir, zoneConfig, zoneName) => {
  // metadata.json
  const metadata = {
    provider: 'zone',
    format: 'zss',
    brand: zoneConfig.brand || 'ipkg',
    architecture: 'amd64', // Default for now
    created_at: new Date().toISOString(),
  };
  await fs.promises.writeFile(
    path.join(tempDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  // info.json
  const info = {
    boxname: zoneName,
    Author: 'Zoneweaver',
    'Vagrant-Zones': 'This box was built with Zoneweaver Agent',
  };
  await fs.promises.writeFile(path.join(tempDir, 'info.json'), JSON.stringify(info, null, 2));

  // Vagrantfile
  const vagrantfileContent = `
Vagrant.configure("2") do |config|
  config.vm.provider :zone do |zone|
    zone.brand = "${zoneConfig.brand || 'ipkg'}"
  end
end
`;
  await fs.promises.writeFile(path.join(tempDir, 'Vagrantfile'), vagrantfileContent);
};

/**
 * Helper to create a box artifact from a zone
 * @param {string} zoneName - Name of the zone to export
 * @param {string} snapshotName - Snapshot to use
 * @param {string} tempDir - Temporary directory for artifact creation
 * @param {Object} task - Task object for progress updates
 * @returns {Promise<{boxPath: string, checksum: string}>}
 */
export const createBoxArtifact = async (zoneName, snapshotName, tempDir, task) => {
  await updateTaskProgress(task, 10, { status: 'getting_zone_config' });

  // 1. Get zone configuration to identify dataset using shared utility
  const zoneConfig = await getZoneConfig(zoneName);

  const dataset = await getZoneBootDataset(zoneConfig);
  if (!dataset) {
    throw new Error(`Could not determine dataset for zone ${zoneName}`);
  }

  await updateTaskProgress(task, 20, { status: 'creating_snapshot' });

  // 2. Create snapshot if not provided
  let snap = snapshotName;
  if (!snap) {
    snap = `export_${Date.now()}`;
    const snapResult = await executeCommand(`pfexec zfs snapshot ${dataset}@${snap}`);
    if (!snapResult.success) {
      throw new Error(`Failed to create snapshot: ${snapResult.error}`);
    }
  }

  await updateTaskProgress(task, 30, { status: 'exporting_stream' });

  // 3. Send stream to file
  const zssPath = path.join(tempDir, 'box.zss');
  const sendCmd = `pfexec zfs send -c ${dataset}@${snap} > "${zssPath}"`;
  // Increase timeout for large streams (1 hour)
  const sendResult = await executeCommand(sendCmd, 3600 * 1000);
  if (!sendResult.success) {
    throw new Error(`Failed to export ZFS stream: ${sendResult.error}`);
  }

  await updateTaskProgress(task, 55, { status: 'creating_metadata' });

  // 4. Create metadata files
  await generateBoxMetadata(tempDir, zoneConfig, zoneName);

  await updateTaskProgress(task, 60, { status: 'packaging_box' });

  // 5. Create .box tarball
  const boxPath = path.join(tempDir, 'vagrant.box');
  // Use pfexec tar to ensure we can read the root-owned zss file
  // Use standard tar flags (GNU tar on OmniOS usually doesn't need -E for large files)
  const tarCmd = `pfexec tar -cvzf "${boxPath}" -C "${tempDir}" metadata.json info.json Vagrantfile box.zss`;
  // Increase timeout for large archives (1 hour)
  const tarResult = await executeCommand(tarCmd, 3600 * 1000);
  if (!tarResult.success) {
    throw new Error(`Failed to package box: ${tarResult.error}`);
  }

  await updateTaskProgress(task, 70, { status: 'calculating_checksum' });

  // 6. Calculate checksum (non-blocking to keep API responsive)
  const checksum = await calculateChecksum(boxPath, 'sha256');

  return { boxPath, checksum };
};
