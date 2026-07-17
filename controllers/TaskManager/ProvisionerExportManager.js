/**
 * @fileoverview Provisioner package export executor (provisioner_export task)
 * @description Host-to-host share, send side (design §7): packs ONE registry
 * version as a REGISTRY-SHAPED tar.gz (<name>/<version>/… inside the archive
 * — the artifact contract, so the receiving agent's import lands it
 * unchanged) plus a .sha256 sidecar of the WHOLE file (no per-file
 * manifests). Archives land under <staging_path>/exports/.
 */

import fs from 'fs';
import path from 'path';
import { executeCommand } from '../../lib/CommandManager.js';
import { calculateChecksum } from '../../lib/ChecksumHelper.js';
import { log } from '../../lib/Logger.js';
import { updateTaskProgress, parseTaskMetadata } from '../../lib/TaskProgressHelper.js';
import { getRegistryDir, getPackageVersion } from '../../lib/ProvisionerRegistry.js';

export const executeProvisionerExportTask = async task => {
  try {
    const metadata = await parseTaskMetadata(task);
    const { name, version } = metadata;
    const { onData } = task;

    const entry = getPackageVersion(name, version);
    if (!entry) {
      return { success: false, error: `Provisioner ${name}/${version} is not in the registry` };
    }

    // <registry>/exports — the shared wire's export location.
    const exportsDir = path.join(getRegistryDir(), 'exports');
    fs.mkdirSync(exportsDir, { recursive: true });
    const archive = path.join(exportsDir, `${name}-${entry.version}.tar.gz`);

    await updateTaskProgress(task, 20, { status: 'packing' });
    onData?.({ stream: 'stdout', data: `Packing ${name}/${entry.version} → ${archive}\n` });
    // REGISTRY-SHAPED: the archive holds <name>/<versionDir>/… so an import
    // on any agent lands it verbatim.
    const packResult = await executeCommand(
      `tar -czf "${archive}" -C "${getRegistryDir()}" "${name}/${entry.dir}"`,
      600000,
      onData
    );
    if (!packResult.success) {
      fs.rmSync(archive, { force: true });
      return { success: false, error: `packing failed: ${packResult.error}` };
    }

    await updateTaskProgress(task, 70, { status: 'checksumming' });
    const checksum = await calculateChecksum(archive, 'sha256');
    fs.writeFileSync(`${archive}.sha256`, `${checksum}  ${path.basename(archive)}\n`, {
      mode: 0o644,
    });

    const { size } = fs.statSync(archive);
    await updateTaskProgress(task, 100, {
      status: 'completed',
      archive,
      sha256: checksum,
      size_bytes: size,
    });
    onData?.({ stream: 'stdout', data: `sha256 ${checksum}\n` });
    return {
      success: true,
      message: `Exported ${name}/${entry.version} → ${archive} (sha256 ${checksum})`,
    };
  } catch (error) {
    log.task.error('Provisioner export failed', { error: error.message });
    return { success: false, error: `Provisioner export failed: ${error.message}` };
  }
};
