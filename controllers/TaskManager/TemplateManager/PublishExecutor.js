import yj from 'yieldable-json';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import { calculateChecksum } from '../../../lib/ChecksumHelper.js';
import {
  getRegistryToken,
  createRegistryClient,
  findSourceConfig,
} from '../../../lib/TemplateRegistryUtils.js';
import { updateTaskProgress } from './utils/ProgressHelper.js';
import { createBoxArtifact } from './utils/BoxArtifactHelper.js';
import { ensureRegistryStructure, uploadRegistryArtifact } from './utils/RegistryUploadHelper.js';

/**
 * @fileoverview Template publish task executor
 */

/**
 * Execute template publish task (Phase III - Part 2 or Combined)
 * Uploads a .box file (from zone export or existing file) to the registry
 * @param {string} metadataJson - Task metadata as JSON string
 * @param {Object} task - The task row (progress updates write it directly)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeTemplatePublishTask = async (metadataJson, task) => {
  log.task.debug('Template publish task starting');
  let tempDir = null;

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const {
      zone_name,
      box_path, // New: Option to upload existing file
      source_name,
      organization,
      box_name,
      version,
      description,
      snapshot_name,
    } = metadata;

    // Find source configuration
    const sourceConfig = findSourceConfig(source_name);
    if (!sourceConfig) {
      return { success: false, error: `Template source not found: ${source_name}` };
    }

    const token = getRegistryToken(sourceConfig);
    const client = createRegistryClient(sourceConfig, token);

    let uploadFilePath;
    let uploadChecksum;

    if (box_path) {
      // Path 1: Upload existing file
      log.task.info('Publishing existing box file', { box_path });
      uploadFilePath = box_path;

      if (!fs.existsSync(uploadFilePath)) {
        return { success: false, error: `Box file not found: ${uploadFilePath}` };
      }

      await updateTaskProgress(task, 10, { status: 'calculating_checksum' });

      // Calculate checksum for existing file (non-blocking to keep API responsive)
      uploadChecksum = await calculateChecksum(uploadFilePath, 'sha256');
    } else if (zone_name) {
      // Path 2: Export from zone then upload (Combined)
      // Create temp directory
      tempDir = path.join(os.tmpdir(), `template_publish_${crypto.randomUUID()}`);
      await fs.promises.mkdir(tempDir, { recursive: true });

      // Create Box Artifact
      const artifact = await createBoxArtifact(zone_name, snapshot_name, tempDir, task);
      uploadFilePath = artifact.boxPath;
      uploadChecksum = artifact.checksum;
    } else {
      return { success: false, error: 'Either zone_name or box_path must be provided' };
    }

    await updateTaskProgress(task, 85, { status: 'uploading_to_registry' });

    // 2. Create Registry Objects
    await ensureRegistryStructure(client, organization, box_name, version, description, zone_name);

    // 3. Upload File
    await uploadRegistryArtifact(
      client,
      sourceConfig,
      token,
      { organization, box_name, version },
      uploadChecksum,
      uploadFilePath,
      task
    );

    await updateTaskProgress(task, 95, { status: 'releasing_version' });

    // 4. Release Version — same conflict tolerance as the structure calls
    // (Go's conflictOK): 400/409 = already released = success, narrated.
    try {
      await client.put(`/api/organization/${organization}/box/${box_name}`, {
        name: box_name,
        published: true,
      });
    } catch (releaseError) {
      if (![400, 409].includes(releaseError.response?.status)) {
        throw releaseError;
      }
      log.task.info('Release answered conflict — box already released', {
        box_name,
        status_code: releaseError.response.status,
      });
    }

    await updateTaskProgress(task, 100, { status: 'completed' });

    return {
      success: true,
      message: `Successfully published ${zone_name || 'file'} to ${organization}/${box_name} v${version}`,
    };
  } catch (error) {
    log.task.error('Template publish task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Template publish failed: ${error.message}` };
  } finally {
    // Cleanup only if we created a temp directory (i.e., exported from zone)
    if (tempDir) {
      await executeCommand(`pfexec rm -rf "${tempDir}"`);
    }
  }
};
