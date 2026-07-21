import { parseAsync } from '../../../lib/AsyncJson.js';
import { log } from '../../../lib/Logger.js';
import path from 'path';

/**
 * Process a single download task for race condition protection
 * @param {Object} downloadTask - Download task object
 * @param {Object} location - Storage location object
 * @returns {Promise<string|null>} Target path if task matches location, null otherwise
 */
export const processDownloadTask = async (downloadTask, location) => {
  log.artifact.debug('Race condition protection: processing download task', {
    task_id: downloadTask.id,
    operation: downloadTask.operation,
    metadata_length: downloadTask.metadata?.length,
  });

  try {
    const downloadMetadata = await parseAsync(downloadTask.metadata);

    const { storage_location_id, filename, url } = downloadMetadata;

    log.artifact.debug('Race condition protection: parsed download metadata', {
      task_id: downloadTask.id,
      download_storage_location_id: storage_location_id,
      scan_location_id: location.id,
      storage_location_match: storage_location_id === location.id,
      filename,
      url: url?.substring(0, 100),
    });

    if (storage_location_id === location.id) {
      let finalFilename = filename;
      if (!finalFilename) {
        const urlPath = new URL(url).pathname;
        finalFilename = path.basename(urlPath) || `download_${Date.now()}`;
      }
      const targetPath = path.join(location.path, finalFilename);

      log.artifact.debug('Race condition protection: added downloading path', {
        task_id: downloadTask.id,
        final_filename: finalFilename,
        target_path: targetPath,
      });

      return targetPath;
    }

    return null;
  } catch (parseError) {
    log.artifact.error('Race condition protection: failed to parse download task metadata', {
      task_id: downloadTask.id,
      error: parseError.message,
      metadata_preview: downloadTask.metadata?.substring(0, 200),
    });
    return null;
  }
};
