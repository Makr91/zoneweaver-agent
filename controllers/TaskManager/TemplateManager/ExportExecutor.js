import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { parseAsync } from '../../../lib/AsyncJson.js';
import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import { updateTaskProgress } from './utils/ProgressHelper.js';
import { createBoxArtifact } from './utils/BoxArtifactHelper.js';

/**
 * @fileoverview Template export task executor
 */

/**
 * Execute template export task (Phase III - Part 1)
 * Exports a zone to a local .box file
 * @param {string} metadataJson - Task metadata as JSON string
 * @param {Object} task - The task row (progress updates write it directly)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeTemplateExportTask = async (metadataJson, task) => {
  log.task.debug('Template export task starting');
  let tempDir = null;

  try {
    const metadata = await parseAsync(metadataJson);

    const { zone_name, snapshot_name, filename } = metadata;

    // Create temp directory
    tempDir = path.join(os.tmpdir(), `template_export_${crypto.randomUUID()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // 1. Create Box Artifact
    const { boxPath, checksum } = await createBoxArtifact(zone_name, snapshot_name, tempDir, task);

    await updateTaskProgress(task, 90, { status: 'moving_to_storage' });

    // 2. Move to destination
    // Default to /var/tmp for now, or use a configured exports directory if available
    const destPath = '/var/tmp';
    const finalFilename = filename || `${zone_name}-${Date.now()}.box`;
    const finalPath = path.join(destPath, finalFilename);

    // Use pfexec to move if needed (cross-device or permission issues)
    const moveResult = await executeCommand(`pfexec mv "${boxPath}" "${finalPath}"`, 3600 * 1000);
    if (!moveResult.success) {
      // Fallback to copy if move fails (e.g. cross-device)
      const copyResult = await executeCommand(`pfexec cp "${boxPath}" "${finalPath}"`, 3600 * 1000);
      if (!copyResult.success) {
        throw new Error(
          `Failed to move artifact to storage: ${moveResult.error} / ${copyResult.error}`
        );
      }
    }

    // Ensure permissions are correct (readable by api user)
    await executeCommand(`pfexec chmod 644 "${finalPath}"`);

    await updateTaskProgress(task, 100, { status: 'completed' });

    return {
      success: true,
      message: `Successfully exported zone ${zone_name} to ${finalFilename}`,
      file_path: finalPath,
      checksum,
    };
  } catch (error) {
    log.task.error('Template export task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Template export failed: ${error.message}` };
  } finally {
    // Cleanup
    if (tempDir) {
      await executeCommand(`pfexec rm -rf "${tempDir}"`);
    }
  }
};
