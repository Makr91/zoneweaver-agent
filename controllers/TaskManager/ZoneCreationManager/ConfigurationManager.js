import { executeCommand } from '../../../lib/CommandManager.js';
import { QGA_EXTRA_VALUE, isGuestAgentEnabled } from '../../../lib/QemuGuestAgent.js';
import { stampDataset } from '../../../lib/DiskSpec.js';
import config from '../../../config/ConfigLoader.js';
import Artifact from '../../../models/ArtifactModel.js';
import {
  buildDatasetPath,
  buildAttrCommand,
  buildZoneAttributeMap,
} from './utils/ConfigBuilders.js';
import { generateVnicName } from './utils/NicHelpers.js';
import { checkZvolInUse } from './utils/ZvolHelper.js';
import { updateTaskProgress } from '../../../lib/TaskProgressHelper.js';

/**
 * Resolve a cdroms[] entry's medium: path verbatim (raw paths stay legal), or
 * iso — a cached-ISO filename resolved through the artifact registry (shared
 * contract with the Go agent). The modify path (add_cdroms) reuses this so
 * create and modify can never drift.
 * @param {Object} cdrom - cdroms[] entry ({path} | {iso})
 * @returns {Promise<string|null>} Resolved ISO path (null to skip the entry)
 */
export const resolveCdromPath = async cdrom => {
  if (cdrom.path) {
    return cdrom.path;
  }
  if (!cdrom.iso) {
    return null;
  }
  if (!config.get('artifact_storage.enabled')) {
    throw new Error(
      'cdroms[].iso references the artifact registry — artifact_storage.enabled is false'
    );
  }
  const artifact = await Artifact.findOne({
    where: { filename: cdrom.iso, file_type: 'iso' },
  });
  if (!artifact) {
    throw new Error(
      `ISO "${cdrom.iso}" is not in any storage location — upload or download it first (GET /artifacts/iso lists what exists)`
    );
  }
  return artifact.path;
};

/**
 * @fileoverview Zone configuration management - zonecfg operations
 */

/**
 * Build the zone's `extra` attr command — the QEMU guest-agent channel
 * (per-machine zones.guest_agent option under the guest_agent.enabled gate;
 * a document carrying its own virtio-console extra wins) merged with any
 * document-provided extra value. Null when no extra attr is needed.
 * @param {Object} metadata - Zone creation metadata
 * @param {string} brand - Zone brand
 * @returns {string|null} zonecfg add-attr command
 */
const buildExtraAttrCommand = (metadata, brand) => {
  const documentExtra =
    typeof metadata.zones?.extra === 'string' && metadata.zones.extra ? metadata.zones.extra : '';
  const wireGuestAgent =
    isGuestAgentEnabled() && metadata.zones?.guest_agent === true && brand === 'bhyve';
  if (wireGuestAgent && !documentExtra.includes('virtio-console')) {
    const extra = documentExtra ? `${documentExtra} ${QGA_EXTRA_VALUE}` : QGA_EXTRA_VALUE;
    return buildAttrCommand('extra', extra);
  }
  if (documentExtra) {
    return buildAttrCommand('extra', documentExtra);
  }
  return null;
};

/**
 * Apply core zone configuration via zonecfg
 * Supports both old structure and new Hosts.yml structure (settings/zones sections)
 * @param {string} zoneName - Zone name
 * @param {Object} metadata - Zone creation metadata
 */
export const applyZoneConfig = async (zoneName, metadata, onData = null) => {
  const pool = metadata.disks?.boot?.pool || 'rpool';
  const dataset = metadata.disks?.boot?.dataset || 'zones';
  const datasetPath = buildDatasetPath(`${pool}/${dataset}`, zoneName, metadata.server_id);
  const zonepath = metadata.zonepath || `/${datasetPath}/path`;
  const autoboot =
    metadata.autoboot === true || metadata.zones?.autostart === true ? 'true' : 'false';
  const brand = metadata.zones?.brand || metadata.brand;

  const createResult = await executeCommand(
    `pfexec zonecfg -z ${zoneName} "create; set zonepath=${zonepath}; set brand=${brand}; set autoboot=${autoboot}; set ip-type=exclusive"`,
    undefined,
    onData
  );
  if (!createResult.success) {
    throw new Error(`Zone configuration failed: ${createResult.error}`);
  }

  const attrMap = buildZoneAttributeMap(metadata);
  const attrCommands = Object.entries(attrMap)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => buildAttrCommand(name, value));

  const extraCommand = buildExtraAttrCommand(metadata, brand);
  if (extraCommand) {
    attrCommands.push(extraCommand);
  }

  const attrs = attrCommands.join(' ');
  if (attrs) {
    const attrResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${attrs}"`,
      undefined,
      onData
    );
    if (!attrResult.success) {
      throw new Error(`Attribute configuration failed: ${attrResult.error}`);
    }
  }
};

/**
 * Configure bootdisk in zone
 * @param {string} zoneName - Zone name
 * @param {string} bootdiskPath - Path to bootdisk dataset
 */
export const configureBootdisk = async (zoneName, bootdiskPath, onData = null) => {
  const bootdiskCmd = `pfexec zonecfg -z ${zoneName} "${buildAttrCommand('bootdisk', bootdiskPath)} add device; set match=/dev/zvol/rdsk/${bootdiskPath}; end;"`;
  const bootdiskResult = await executeCommand(bootdiskCmd, undefined, onData);
  if (!bootdiskResult.success) {
    throw new Error(`Bootdisk configuration failed: ${bootdiskResult.error}`);
  }
};

/**
 * Configure additional disks in zone — TYPED entries (disk spec): blank =
 * create a fresh zvol and stamp it ours; template = materialize from a
 * snapshot (the clone path's data-complete enrichment — zfs clone, or full
 * send/recv when clone_strategy is copy — stamped ours); image = attach the
 * declared path as-is (never created, never stamped; per-ENTRY force
 * overrides the in-use refusal, frozen H3 semantics).
 * @param {string} zoneName - Zone name
 * @param {Array} disks - Typed additional_disks[] entries
 * @param {Array} zfsCreated - Array to track created datasets for rollback
 * @param {Object} metadata - Zone creation metadata (for server_id)
 */
export const configureAdditionalDisks = async (
  zoneName,
  disks,
  zfsCreated,
  metadata,
  onData = null
) => {
  const zfsPromises = [];
  const zonecfgCmds = [];

  for (let i = 0; i < disks.length; i++) {
    const disk = disks[i];
    let diskPath = null;

    if (disk.type === 'blank') {
      const pool = disk.pool || 'rpool';
      const dset = disk.dataset || 'zones';
      const volName = disk.volume_name || `disk${i}`;
      const datasetPath = buildDatasetPath(`${pool}/${dset}`, zoneName, metadata.server_id);
      diskPath = `${datasetPath}/${volName}`;

      const sparseFlag = disk.sparse !== false ? '-s' : '';
      zfsPromises.push(
        executeCommand(`pfexec zfs create ${sparseFlag} -V ${disk.size} ${diskPath}`).then(
          async res => {
            if (!res.success) {
              throw new Error(`Failed to create disk ${i}: ${res.error}`);
            }
            zfsCreated.push(diskPath);
            await stampDataset(diskPath, 'blank');
            return diskPath;
          }
        )
      );
    } else if (disk.type === 'template') {
      const pool = disk.pool || 'rpool';
      const dset = disk.dataset || 'zones';
      const volName = disk.volume_name || `disk${i}`;
      const datasetPath = buildDatasetPath(`${pool}/${dset}`, zoneName, metadata.server_id);
      diskPath = `${datasetPath}/${volName}`;

      const snapshotSource = `${disk.template_dataset}@${disk.snapshot_name}`;
      const materialize =
        disk.clone_strategy === 'copy'
          ? `pfexec zfs send ${snapshotSource} | pfexec zfs recv -F ${diskPath}`
          : `pfexec zfs clone ${snapshotSource} ${diskPath}`;
      zfsPromises.push(
        executeCommand(materialize, 3600 * 1000, onData).then(async res => {
          if (!res.success) {
            throw new Error(`Failed to clone disk ${i} from ${snapshotSource}: ${res.error}`);
          }
          zfsCreated.push(diskPath);
          await stampDataset(diskPath, disk.provenance === 'clone' ? 'clone' : 'template');
          return diskPath;
        })
      );
    } else {
      // type: image — task-time in-use guard (pre-flight ran at create; a
      // race between then and now still refuses honestly).
      diskPath = disk.path;
      zfsPromises.push(
        checkZvolInUse(diskPath).then(usageCheck => {
          if (usageCheck.inUse && disk.force !== true) {
            throw new Error(
              `disks.additional_disks[${i + 1}].path ${diskPath} is attached to ${usageCheck.usedBy} (set force: true to attach anyway)`
            );
          }
          return diskPath;
        })
      );
    }

    zonecfgCmds.push(
      `${buildAttrCommand(`disk${i}`, diskPath)} add device; set match=/dev/zvol/rdsk/${diskPath}; end;`
    );
  }

  // Wait for ZFS operations
  await Promise.all(zfsPromises);

  // Apply zonecfg in batch
  if (zonecfgCmds.length > 0) {
    const diskResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${zonecfgCmds.join(' ')}"`,
      undefined,
      onData
    );
    if (!diskResult.success) {
      throw new Error(`Disk configuration failed: ${diskResult.error}`);
    }
  }
};

/**
 * Configure CD-ROMs in zone
 * @param {string} zoneName - Zone name
 * @param {Array} cdroms - Array of CDROM configurations
 */
export const configureCdroms = async (zoneName, cdroms, onData = null) => {
  const resolved = await Promise.all(cdroms.map(cdrom => resolveCdromPath(cdrom)));
  const cmds = resolved.filter(Boolean).map((isoPath, i) => {
    // Single CD: 'cdrom', multiple: 'cdrom0', 'cdrom1', etc.
    const attrName = resolved.filter(Boolean).length === 1 ? 'cdrom' : `cdrom${i}`;
    return `${buildAttrCommand(attrName, isoPath)} add fs; set dir=${isoPath}; set special=${isoPath}; set type=lofs; add options ro; add options nodevices; end;`;
  });

  if (cmds.length > 0) {
    const cdromResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${cmds.join(' ')}"`,
      undefined,
      onData
    );
    if (!cdromResult.success) {
      throw new Error(`CDROM configuration failed: ${cdromResult.error}`);
    }
  }
};

/**
 * Build one zonecfg `add fs` block for a filesystems[] entry — generic lofs
 * (or other fs-type) mounts into the zone: {special (host path), dir
 * (in-zone path, defaults to special), type (default lofs), options
 * (default [nodevices])}.
 * @param {Object} entry - filesystems[] entry
 * @returns {string} zonecfg add-fs command
 */
export const buildFilesystemCommand = entry => {
  const { special } = entry;
  const dir = entry.dir || special;
  const type = entry.type || 'lofs';
  const options = Array.isArray(entry.options) ? entry.options : ['nodevices'];
  const optionCmds = options.map(option => ` add options ${option};`).join('');
  return `add fs; set dir=${dir}; set special=${special}; set type=${type};${optionCmds} end;`;
};

/**
 * Configure filesystem mounts in zone (generic lofs shares and friends)
 * @param {string} zoneName - Zone name
 * @param {Array} filesystems - Array of filesystems[] entries
 */
export const configureFilesystems = async (zoneName, filesystems, onData = null) => {
  const entries = filesystems.filter(entry => entry && entry.special);
  if (entries.length !== filesystems.length) {
    throw new Error('filesystems[] entries need a special (host path)');
  }
  const cmds = entries.map(entry => buildFilesystemCommand(entry));

  if (cmds.length > 0) {
    const fsResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${cmds.join(' ')}"`,
      undefined,
      onData
    );
    if (!fsResult.success) {
      throw new Error(`Filesystem configuration failed: ${fsResult.error}`);
    }
  }
};

/**
 * Configure NICs in zone
 * @param {string} zoneName - Zone name
 * @param {Array} nics - Array of NIC configurations
 * @param {Object} metadata - Zone creation metadata (for VNIC name generation)
 */
export const configureNics = async (zoneName, nics, metadata, onData = null) => {
  const cmds = nics.map((nic, index) => {
    const physical = nic.physical || generateVnicName(nic, index, metadata);
    let cmd = `add net; set physical=${physical};`;
    if (nic.global_nic) {
      cmd += ` set global-nic=${nic.global_nic};`;
    }
    if (nic.vlan_id) {
      cmd += ` set vlan-id=${nic.vlan_id};`;
    }
    if (nic.mac_addr) {
      cmd += ` set mac-addr=${nic.mac_addr};`;
    }
    if (nic.allowed_address) {
      cmd += ` set allowed-address=${nic.allowed_address};`;
    }
    cmd += ` end;`;
    return cmd;
  });

  if (cmds.length > 0) {
    const nicResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${cmds.join(' ')}"`,
      undefined,
      onData
    );
    if (!nicResult.success) {
      throw new Error(`NIC configuration failed: ${nicResult.error}`);
    }
  }
};

/**
 * Configure cloud-init attributes in zone
 * @param {string} zoneName - Zone name
 * @param {Object} cloudInit - Cloud-init configuration
 */
export const configureCloudInit = async (zoneName, cloudInit, onData = null) => {
  const attrs = [];

  if (cloudInit.enabled) {
    attrs.push(buildAttrCommand('cloud-init', cloudInit.enabled));
  }
  if (cloudInit.dns_domain) {
    attrs.push(buildAttrCommand('dns-domain', cloudInit.dns_domain));
  }
  if (cloudInit.password) {
    attrs.push(buildAttrCommand('password', cloudInit.password));
  }
  if (cloudInit.resolvers) {
    attrs.push(buildAttrCommand('resolvers', cloudInit.resolvers));
  }
  if (cloudInit.sshkey) {
    attrs.push(buildAttrCommand('sshkey', cloudInit.sshkey));
  }

  if (attrs.length > 0) {
    const cloudCmd = `pfexec zonecfg -z ${zoneName} "${attrs.join(' ')}"`;
    const cloudResult = await executeCommand(cloudCmd, undefined, onData);
    if (!cloudResult.success) {
      throw new Error(`Cloud-init configuration failed: ${cloudResult.error}`);
    }
  }
};

/**
 * Apply all zone configuration: core config, bootdisk, disks, cdroms, nics, cloud-init
 * @param {string} zoneName - Zone name
 * @param {Object} metadata - Zone creation metadata
 * @param {string|null} bootdiskPath - Boot disk path
 * @param {Array} zfsCreated - Array to track created datasets for rollback
 * @param {Object} task - Task object for progress updates
 */
export const applyAllZoneConfig = async (
  zoneName,
  metadata,
  bootdiskPath,
  zfsCreated,
  task,
  onData = null
) => {
  await updateTaskProgress(task, 40, { status: 'configuring_zone' });
  await applyZoneConfig(zoneName, metadata, onData);

  if (bootdiskPath) {
    await updateTaskProgress(task, 50, { status: 'configuring_bootdisk' });
    await configureBootdisk(zoneName, bootdiskPath, onData);
  }

  if (metadata.disks?.additional_disks?.length > 0) {
    await updateTaskProgress(task, 60, { status: 'configuring_disks' });
    await configureAdditionalDisks(
      zoneName,
      metadata.disks.additional_disks,
      zfsCreated,
      metadata,
      onData
    );
  }

  if (metadata.disks?.cdroms?.length > 0) {
    await updateTaskProgress(task, 70, { status: 'configuring_cdroms' });
    await configureCdroms(zoneName, metadata.disks.cdroms, onData);
  }

  if (metadata.filesystems?.length > 0) {
    await updateTaskProgress(task, 72, { status: 'configuring_filesystems' });
    await configureFilesystems(zoneName, metadata.filesystems, onData);
  }

  if (metadata.nics?.length > 0) {
    await updateTaskProgress(task, 75, { status: 'configuring_network' });
    await configureNics(zoneName, metadata.nics, metadata, onData);
  }

  if (metadata.cloud_init) {
    await updateTaskProgress(task, 80, { status: 'configuring_cloud_init' });
    await configureCloudInit(zoneName, metadata.cloud_init, onData);
  }
};
