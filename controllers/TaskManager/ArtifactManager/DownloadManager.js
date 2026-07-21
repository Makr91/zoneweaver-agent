import { parseAsync } from '../../../lib/AsyncJson.js';
import { executeCommand } from '../../../lib/CommandManager.js';
import { isTaskCancelled } from '../../../lib/TaskContext.js';
import { log } from '../../../lib/Logger.js';
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import config from '../../../config/ConfigLoader.js';
import ArtifactStorageLocation from '../../../models/ArtifactStorageLocationModel.js';
import Artifact from '../../../models/ArtifactModel.js';
import { getMimeType } from '../../../lib/FileSystemManager.js';

/**
 * Download Manager for Artifact Downloads
 * Handles artifact downloads from URLs with progress tracking and verification
 */

/**
 * Setup download file and permissions
 * @param {string} final_path - Final file path
 * @returns {Promise<void>}
 */
export const setupDownloadFile = async final_path => {
  log.task.debug('Pre-creating download file with pfexec', { final_path });

  const createResult = await executeCommand(`pfexec touch "${final_path}"`);
  if (!createResult.success) {
    throw new Error(`Failed to pre-create file: ${createResult.error}`);
  }

  const chmodResult = await executeCommand(`pfexec chmod 666 "${final_path}"`);
  if (!chmodResult.success) {
    throw new Error(`Failed to set file permissions: ${chmodResult.error}`);
  }

  log.task.debug('File pre-created successfully with proper permissions');
};

/**
 * Perform the actual download with progress tracking
 * @param {string} url - Download URL
 * @param {string} final_path - Final file path
 * @param {number} downloadTimeout - Download timeout in ms
 * @param {Object} [task] - The task row (progress updates write it directly)
 * @returns {Promise<{downloadedBytes: number, downloadTime: number}>}
 */
export const performDownload = async (url, final_path, downloadTimeout, task = null) => {
  const abort = new AbortController();
  const response = await axios({
    method: 'get',
    url,
    responseType: 'stream',
    timeout: downloadTimeout,
    signal: abort.signal,
  });

  const contentLength = response.headers['content-length'];
  const fileSize = contentLength ? parseInt(contentLength) : null;

  log.task.info('Download response received', {
    status: response.status,
    content_length: fileSize ? `${Math.round(fileSize / 1024 / 1024)}MB` : 'unknown',
    content_type: response.headers['content-type'],
  });

  const fileStream = fs.createWriteStream(final_path);
  const startTime = Date.now();
  let downloadedBytes = 0;
  let lastProgressUpdate = 0;

  const artifactConfig = config.getArtifactStorage();

  let cancelled = false;
  response.data.on('data', chunk => {
    downloadedBytes += chunk.length;

    // Cooperative cancel: a running-task cancel aborts the stream mid-flight
    // instead of downloading to the natural end.
    if (!cancelled && isTaskCancelled(task?.id)) {
      cancelled = true;
      abort.abort();
      return;
    }

    const progressUpdateInterval = (artifactConfig.download?.progress_update_seconds || 10) * 1000;
    const now = Date.now();
    if (fileSize && now - lastProgressUpdate > progressUpdateInterval) {
      lastProgressUpdate = now;

      setImmediate(async () => {
        try {
          const progress = (downloadedBytes / fileSize) * 100;
          const speedMbps = downloadedBytes / 1024 / 1024 / ((now - startTime) / 1000);
          const remainingBytes = fileSize - downloadedBytes;
          const etaSeconds = remainingBytes / (downloadedBytes / ((now - startTime) / 1000));

          if (task) {
            await task.update({
              progress_percent: Math.round(progress * 100) / 100,
              progress_info: {
                downloaded_mb: Math.round(downloadedBytes / 1024 / 1024),
                total_mb: Math.round(fileSize / 1024 / 1024),
                speed_mbps: Math.round(speedMbps * 100) / 100,
                eta_seconds: isFinite(etaSeconds) ? Math.round(etaSeconds) : null,
                status: 'downloading',
              },
            });
          }
        } catch (progressError) {
          log.task.debug('Progress update failed', { error: progressError.message });
        }
      });
    }
  });

  response.data.pipe(fileStream);

  try {
    await new Promise((resolve, reject) => {
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
      response.data.on('error', reject);
    });
  } catch (streamError) {
    fileStream.destroy();
    if (cancelled) {
      await executeCommand(`pfexec rm -f "${final_path}"`);
      throw new Error('Download cancelled — partial file removed');
    }
    throw streamError;
  }

  const downloadTime = Date.now() - startTime;

  log.task.info('Download completed - starting post-processing', {
    url,
    downloaded_bytes: downloadedBytes,
    downloaded_mb: Math.round(downloadedBytes / 1024 / 1024),
    duration_ms: downloadTime,
    speed_mbps: Math.round((downloadedBytes / 1024 / 1024 / (downloadTime / 1000)) * 100) / 100,
  });

  return { downloadedBytes, downloadTime };
};

/**
 * Calculate and verify checksum
 * @param {string} final_path - Final file path
 * @param {string} checksum_algorithm - Checksum algorithm
 * @param {string} expectedChecksum - Expected checksum (optional)
 * @returns {Promise<{calculatedChecksum: string, checksumVerified: boolean|null}>}
 */
export const calculateAndVerifyChecksum = async (
  final_path,
  checksum_algorithm,
  expectedChecksum
) => {
  log.task.debug('Calculating checksum post-download');

  const hash = crypto.createHash(checksum_algorithm);
  const readStream = fs.createReadStream(final_path);

  await new Promise((resolve, reject) => {
    readStream.on('data', chunk => hash.update(chunk));
    readStream.on('end', resolve);
    readStream.on('error', reject);
  });

  const calculatedChecksum = hash.digest('hex');
  let checksumVerified = null;

  if (expectedChecksum) {
    checksumVerified = calculatedChecksum === expectedChecksum;

    if (!checksumVerified) {
      await executeCommand(`pfexec rm -f "${final_path}"`);
      throw new Error(
        `Checksum verification failed. Expected: ${expectedChecksum}, Got: ${calculatedChecksum}`
      );
    }
    log.task.info('Checksum verification passed');
  }

  return { calculatedChecksum, checksumVerified };
};

/**
 * Create artifact database record
 * @param {Object} params - Parameters object
 * @returns {Promise<void>}
 */
export const createArtifactRecord = async params => {
  const {
    storageLocation,
    finalFilename,
    final_path,
    downloadedBytes,
    calculatedChecksum,
    checksum_algorithm,
    checksumVerified,
    url,
  } = params;

  const extension = path.extname(finalFilename).toLowerCase();
  const mimeType = getMimeType(final_path);

  if (!extension) {
    throw new Error(`File has no extension - cannot determine artifact type: ${finalFilename}`);
  }

  try {
    const [artifact, created] = await Artifact.findOrCreate({
      where: { path: final_path },
      defaults: {
        storage_location_id: storageLocation.id,
        filename: finalFilename,
        path: final_path,
        size: downloadedBytes,
        file_type: storageLocation.type,
        extension,
        mime_type: mimeType,
        checksum: calculatedChecksum,
        checksum_algorithm,
        checksum_verified: checksumVerified,
        source_url: url,
        discovered_at: new Date(),
        last_verified: new Date(),
      },
    });

    if (!created) {
      log.task.info('Artifact record already exists, updating with download data', {
        filename: finalFilename,
        existing_source: artifact.source_url || 'scan',
        new_source: url,
        checksum_verified: checksumVerified,
      });

      await artifact.update({
        filename: finalFilename,
        size: downloadedBytes,
        checksum: calculatedChecksum,
        checksum_algorithm,
        checksum_verified: checksumVerified,
        source_url: url,
        last_verified: new Date(),
      });
    } else {
      log.task.debug('Created new artifact database record', {
        filename: finalFilename,
        path: final_path,
        checksum_verified: checksumVerified,
      });
    }
  } catch (dbError) {
    log.task.error('Failed to create/update artifact database record', {
      storage_location_id: storageLocation.id,
      filename: finalFilename,
      path: final_path,
      size: downloadedBytes,
      file_type: storageLocation.type,
      extension,
      mime_type: mimeType,
      error: dbError.message,
      validation_errors: dbError.errors || null,
    });

    await executeCommand(`pfexec rm -f "${final_path}"`);
    throw new Error(`Download completed but failed to create database record: ${dbError.message}`);
  }
};

/**
 * Execute artifact download from URL task
 * @param {string} metadataJson - Task metadata as JSON string
 * @param {Object} [task] - The task row (progress updates write it directly)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeArtifactDownloadTask = async (metadataJson, task = null) => {
  log.task.debug('Artifact download task starting');

  try {
    const metadata = await parseAsync(metadataJson);

    const {
      url,
      storage_location_id,
      filename,
      checksum,
      checksum_algorithm = 'sha256',
      overwrite_existing = false,
    } = metadata;

    log.task.debug('Artifact download task parameters', {
      url,
      storage_location_id,
      filename,
      has_checksum: !!checksum,
      checksum_algorithm,
      overwrite_existing,
    });

    const storageLocation = await ArtifactStorageLocation.findByPk(storage_location_id);

    if (!storageLocation || !storageLocation.enabled) {
      return {
        success: false,
        error: `Storage location not found or disabled: ${storage_location_id}`,
      };
    }

    let finalFilename = filename;
    if (!finalFilename) {
      const urlPath = new URL(url).pathname;
      finalFilename = path.basename(urlPath) || `download_${Date.now()}`;
    }

    const final_path = path.join(storageLocation.path, finalFilename);

    if (!overwrite_existing && fs.existsSync(final_path)) {
      return {
        success: false,
        error: `File already exists: ${finalFilename}. Use overwrite_existing=true to replace.`,
      };
    }

    log.task.info('Starting download', {
      url,
      destination: final_path,
      storage_location: storageLocation.name,
    });

    await setupDownloadFile(final_path);

    const artifactConfig = config.getArtifactStorage();
    const downloadTimeout = (artifactConfig.download?.timeout_seconds || 60) * 1000;

    const { downloadedBytes, downloadTime } = await performDownload(
      url,
      final_path,
      downloadTimeout,
      task
    );

    const { calculatedChecksum, checksumVerified } = await calculateAndVerifyChecksum(
      final_path,
      checksum_algorithm,
      checksum
    );

    await createArtifactRecord({
      storageLocation,
      finalFilename,
      final_path,
      downloadedBytes,
      calculatedChecksum,
      checksum_algorithm,
      checksumVerified,
      url,
    });

    await storageLocation.increment('file_count', { by: 1 });
    await storageLocation.increment('total_size', { by: downloadedBytes });
    await storageLocation.update({ last_scan_at: new Date() });

    return {
      success: true,
      message: `Successfully downloaded ${finalFilename} (${Math.round(downloadedBytes / 1024 / 1024)}MB)${checksumVerified ? ' with verified checksum' : ''}`,
      downloaded_bytes: downloadedBytes,
      checksum_verified: checksumVerified,
      checksum: calculatedChecksum,
      final_path,
      duration_ms: downloadTime,
    };
  } catch (error) {
    log.task.error('Artifact download task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Download failed: ${error.message}` };
  }
};
