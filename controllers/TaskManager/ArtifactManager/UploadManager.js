import yj from 'yieldable-json';
import { log } from '../../../lib/Logger.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import ArtifactStorageLocation from '../../../models/ArtifactStorageLocationModel.js';
import Artifact from '../../../models/ArtifactModel.js';
import { getMimeType } from '../../../lib/FileSystemManager.js';

/**
 * Upload Manager for Artifact Uploads
 * Handles artifact upload processing and verification
 */

/**
 * Execute artifact upload processing task
 * @param {string} metadataJson - Task metadata as JSON string
 * @param {Object} taskToUpdate - The task row (progress updates write it directly)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeArtifactUploadProcessTask = async (metadataJson, taskToUpdate) => {
  log.task.debug('Artifact upload process task starting');

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
      final_path,
      original_name,
      size,
      storage_location_id,
      checksum,
      checksum_algorithm = 'sha256',
    } = metadata;

    if (!final_path) {
      log.task.error('No final_path provided in metadata', {
        metadata_keys: Object.keys(metadata),
      });
      return {
        success: false,
        error: 'No final_path provided in task metadata - cannot process upload',
      };
    }

    log.task.debug('Upload process task parameters', {
      final_path,
      original_name,
      size,
      storage_location_id,
      has_checksum: !!checksum,
    });

    // Get storage location
    const storageLocation = await ArtifactStorageLocation.findByPk(storage_location_id);
    if (!storageLocation) {
      return {
        success: false,
        error: `Storage location not found: ${storage_location_id}`,
      };
    }

    // Calculate checksum with progress tracking
    log.task.debug('Calculating checksum');

    const hash = crypto.createHash(checksum_algorithm);
    const stream = fs.createReadStream(final_path);

    if (taskToUpdate) {
      await taskToUpdate.update({
        progress_percent: 50,
        progress_info: {
          status: 'calculating_checksum',
          file_size_mb: Math.round(size / 1024 / 1024),
        },
      });
    }

    for await (const chunk of stream) {
      hash.update(chunk);
    }

    const calculatedChecksum = hash.digest('hex');

    // Update progress after checksum
    if (taskToUpdate) {
      await taskToUpdate.update({
        progress_percent: 80,
        progress_info: {
          status: 'checksum_complete',
          checksum: `${calculatedChecksum.substring(0, 16)}...`,
        },
      });
    }

    log.task.debug('Checksum calculated', {
      algorithm: checksum_algorithm,
      checksum: `${calculatedChecksum.substring(0, 16)}...`,
    });

    // Determine checksum verification status
    let checksumVerified = null; // Default: no verification performed

    // Scenario 1: User provided checksum - verify and fail if mismatch
    if (checksum) {
      if (calculatedChecksum !== checksum) {
        return {
          success: false,
          error: `Checksum verification failed. Expected: ${checksum}, Got: ${calculatedChecksum}`,
        };
      }
      checksumVerified = true; // User checksum verified successfully
      log.task.info('Upload checksum verification passed');
    }

    // Scenario 2: Both scenarios - store the calculated checksum as the final value
    const extension = path.extname(original_name).toLowerCase();
    const mimeType = getMimeType(final_path);

    // Create artifact database record with checksum verification status
    await Artifact.create({
      storage_location_id: storageLocation.id,
      filename: original_name,
      path: final_path,
      size,
      file_type: storageLocation.type,
      extension,
      mime_type: mimeType,
      checksum: calculatedChecksum,
      checksum_algorithm,
      checksum_verified: checksumVerified,
      source_url: null,
      discovered_at: new Date(),
      last_verified: new Date(),
    });

    // Update storage location stats
    await storageLocation.increment('file_count', { by: 1 });
    await storageLocation.increment('total_size', { by: size });
    await storageLocation.update({ last_scan_at: new Date() });

    // Final progress update
    if (taskToUpdate) {
      await taskToUpdate.update({
        progress_percent: 100,
        progress_info: {
          status: 'completed',
          final_path,
          checksum_verified: !!checksum,
        },
      });
    }

    log.task.info('Artifact upload processing completed', {
      filename: original_name,
      size_mb: Math.round(size / 1024 / 1024),
      storage_location: storageLocation.name,
      checksum_verified: !!checksum,
    });

    return {
      success: true,
      message: `Successfully processed upload for ${original_name} (${Math.round(size / 1024 / 1024)}MB)${checksum ? ' with verified checksum' : ''}`,
      artifact: {
        filename: original_name,
        size,
        final_path,
        checksum_verified: !!checksum,
        checksum: calculatedChecksum,
      },
    };
  } catch (error) {
    // No cleanup needed - file is already in final location
    log.task.error('Artifact upload process task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Upload processing failed: ${error.message}` };
  }
};
