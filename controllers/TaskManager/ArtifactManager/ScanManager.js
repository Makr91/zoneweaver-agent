import yj from 'yieldable-json';
import { log } from '../../../lib/Logger.js';
import path from 'path';
import config from '../../../config/ConfigLoader.js';
import ArtifactStorageLocation from '../../../models/ArtifactStorageLocationModel.js';
import Artifact from '../../../models/ArtifactModel.js';
import { Op } from 'sequelize';
import { listDirectory, getMimeType } from '../../../lib/FileSystemManager.js';
import { processDownloadTask } from './ScanDownloadTask.js';

/**
 * Scan Manager for Artifact Scanning
 * Handles storage location scanning and artifact discovery
 */

/**
 * Get downloading paths to avoid race conditions during scanning
 * @param {Object} location - Storage location object
 * @returns {Promise<Set>} Set of paths currently being downloaded
 */
export const getDownloadingPaths = async location => {
  const runningDownloadTasks = Array.from(global.runningTasks?.values() || []).filter(
    task => task.operation === 'artifact_download_url'
  );

  log.artifact.debug('Race condition protection: checking running tasks', {
    running_download_tasks: runningDownloadTasks.length,
    location_id: location.id,
    location_path: location.path,
    running_task_ids: runningDownloadTasks.map(t => t.id),
  });

  const pathPromises = runningDownloadTasks.map(downloadTask =>
    processDownloadTask(downloadTask, location)
  );
  const targetPaths = await Promise.all(pathPromises);

  const downloadingPaths = new Set(targetPaths.filter(targetPath => targetPath !== null));

  if (downloadingPaths.size > 0) {
    log.artifact.info('Race condition protection: found active downloads to skip during scan', {
      active_downloads: downloadingPaths.size,
      downloading_paths: Array.from(downloadingPaths),
      location_name: location.name,
    });
  } else {
    log.artifact.debug('Race condition protection: no active downloads found for this location', {
      location_name: location.name,
      total_running_downloads: runningDownloadTasks.length,
    });
  }

  return downloadingPaths;
};

/**
 * Process artifact files and update database records
 * @param {Object} location - Storage location object
 * @param {Array} artifactFiles - Array of artifact files
 * @param {Set} downloadingPaths - Set of paths being downloaded
 * @param {Set} existingPaths - Set of existing database paths
 * @returns {Promise<{scanned: number, added: number, skipped: number}>}
 */
export const processArtifactFiles = async (
  location,
  artifactFiles,
  downloadingPaths,
  existingPaths
) => {
  const filesToCreate = [];
  const pathsToUpdate = [];
  let skipped = 0;

  for (const file of artifactFiles) {
    log.artifact.debug('Race condition protection: checking file against downloading paths', {
      file_path: file.path,
      downloading_paths_count: downloadingPaths.size,
      should_skip: downloadingPaths.has(file.path),
      downloading_paths: Array.from(downloadingPaths),
      file_exists_in_db: existingPaths.has(file.path),
    });

    if (downloadingPaths.has(file.path)) {
      log.artifact.info('Race condition protection: skipping file being downloaded', {
        filename: file.name,
        path: file.path,
        location_name: location.name,
      });
      skipped++;
      continue;
    }

    if (!existingPaths.has(file.path)) {
      const extension = path.extname(file.name).toLowerCase();
      const mimeType = getMimeType(file.path);

      log.artifact.debug('Race condition protection: creating new artifact record', {
        filename: file.name,
        path: file.path,
        size: file.size,
        extension,
        location_name: location.name,
      });

      filesToCreate.push({
        storage_location_id: location.id,
        filename: file.name,
        path: file.path,
        size: file.size || 0,
        file_type: location.type,
        extension,
        mime_type: mimeType,
        checksum: null,
        checksum_algorithm: null,
        source_url: null,
        discovered_at: new Date(),
        last_verified: new Date(),
      });
    } else {
      pathsToUpdate.push(file.path);
    }
  }

  const operations = [];

  if (filesToCreate.length > 0) {
    operations.push(Artifact.bulkCreate(filesToCreate));
  }

  if (pathsToUpdate.length > 0) {
    operations.push(
      Artifact.update(
        { last_verified: new Date() },
        { where: { path: { [Op.in]: pathsToUpdate } } }
      )
    );
  }

  await Promise.all(operations);

  const scanned = artifactFiles.length - skipped;
  const added = filesToCreate.length;

  if (added > 0) {
    log.artifact.debug('Bulk created new artifacts', {
      count: added,
      location_name: location.name,
    });
  }

  return { scanned, added, skipped };
};

/**
 * Remove orphaned artifacts from database
 * @param {Array} existingArtifacts - Array of existing artifacts
 * @param {Set} currentPaths - Set of current file paths
 * @returns {Promise<number>} Number of removed artifacts
 */
export const removeOrphanedArtifacts = async (existingArtifacts, currentPaths) => {
  const orphanedIds = existingArtifacts
    .filter(artifact => !currentPaths.has(artifact.path))
    .map(artifact => {
      log.artifact.debug('Removed orphaned artifact', {
        filename: artifact.filename,
        path: artifact.path,
      });
      return artifact.id;
    });

  if (orphanedIds.length > 0) {
    await Artifact.destroy({
      where: { id: { [Op.in]: orphanedIds } },
    });
  }

  return orphanedIds.length;
};

/**
 * Update storage location statistics
 * @param {Object} location - Storage location object
 * @returns {Promise<{totalFiles: number, totalSize: number}>}
 */
export const updateStorageLocationStats = async location => {
  const totalFiles = await Artifact.count({
    where: { storage_location_id: location.id },
  });

  const totalSize =
    (await Artifact.sum('size', {
      where: { storage_location_id: location.id },
    })) || 0;

  await location.update({
    file_count: totalFiles,
    total_size: totalSize,
  });

  return { totalFiles, totalSize };
};

/**
 * Scan a storage location for artifacts
 * @param {Object} location - Storage location object
 * @param {Object} options - Scan options
 * @returns {Promise<{scanned: number, added: number, removed: number}>}
 */
export const scanStorageLocation = async (location, options = {}) => {
  const { verify_checksums = false, remove_orphaned = false } = options;

  log.artifact.debug('Scanning storage location', {
    location_id: location.id,
    location_name: location.name,
    location_path: location.path,
    verify_checksums,
    remove_orphaned,
  });

  try {
    const artifactConfig = config.getArtifactStorage();
    const supportedExtensions =
      artifactConfig?.scanning?.supported_extensions?.[location.type] || [];

    const downloadingPaths = await getDownloadingPaths(location);

    const items = await listDirectory(location.path);
    const files = items.filter(item => !item.isDirectory);
    const artifactFiles = files.filter(file =>
      supportedExtensions.some(ext => file.name.toLowerCase().endsWith(ext.toLowerCase()))
    );

    log.artifact.debug('Found potential artifacts', {
      total_files: files.length,
      artifact_files: artifactFiles.length,
      supported_extensions: supportedExtensions,
    });

    const existingArtifacts = await Artifact.findAll({
      where: { storage_location_id: location.id },
    });

    const existingPaths = new Set(existingArtifacts.map(a => a.path));
    const currentPaths = new Set(files.map(f => f.path));

    const { scanned, added, skipped } = await processArtifactFiles(
      location,
      artifactFiles,
      downloadingPaths,
      existingPaths
    );

    const removed = remove_orphaned
      ? await removeOrphanedArtifacts(existingArtifacts, currentPaths)
      : 0;

    const { totalFiles } = await updateStorageLocationStats(location);

    log.artifact.info('Storage location scan completed', {
      location_name: location.name,
      scanned,
      added,
      removed,
      skipped,
      total_files: totalFiles,
    });

    return { scanned, added, removed };
  } catch (error) {
    log.artifact.error('Storage location scan failed', {
      location_id: location.id,
      location_name: location.name,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
};

/**
 * Execute scan all artifact locations task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeArtifactScanAllTask = async metadataJson => {
  log.task.debug('Artifact scan all task starting');

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

    const { verify_checksums = false, remove_orphaned = false, source = 'manual' } = metadata;

    log.task.debug('Scan all task parameters', {
      verify_checksums,
      remove_orphaned,
      source,
    });

    const locations = await ArtifactStorageLocation.findAll({
      where: { enabled: true },
    });

    let totalScanned = 0;
    let totalAdded = 0;
    let totalRemoved = 0;
    const errors = [];

    const scanPromises = locations.map(async location => {
      try {
        const scanResult = await scanStorageLocation(location, {
          verify_checksums,
          remove_orphaned,
        });

        await location.update({
          last_scan_at: new Date(),
          scan_errors: 0,
          last_error_message: null,
        });

        return { success: true, scanResult, location };
      } catch (locationError) {
        const errorMsg = `Failed to scan ${location.name}: ${locationError.message}`;

        await location.update({
          scan_errors: location.scan_errors + 1,
          last_error_message: locationError.message,
        });

        log.task.warn('Storage location scan failed', {
          location_id: location.id,
          location_name: location.name,
          error: locationError.message,
        });

        return { success: false, error: errorMsg, location };
      }
    });

    const scanResults = await Promise.all(scanPromises);

    for (const result of scanResults) {
      if (result.success) {
        totalScanned += result.scanResult.scanned;
        totalAdded += result.scanResult.added;
        totalRemoved += result.scanResult.removed;
      } else {
        errors.push(result.error);
      }
    }

    if (errors.length > 0 && errors.length === locations.length) {
      return {
        success: false,
        error: `All ${locations.length} storage locations failed to scan`,
        errors,
      };
    }

    const successCount = locations.length - errors.length;
    let message = `Scan completed: ${totalScanned} files scanned, ${totalAdded} added, ${totalRemoved} removed across ${successCount}/${locations.length} locations`;

    if (errors.length > 0) {
      message += ` (${errors.length} locations had errors)`;
    }

    log.task.info('Artifact scan all completed', {
      locations_scanned: successCount,
      locations_failed: errors.length,
      total_scanned: totalScanned,
      total_added: totalAdded,
      total_removed: totalRemoved,
      source,
    });

    return {
      success: true,
      message,
      stats: {
        locations_scanned: successCount,
        locations_failed: errors.length,
        files_scanned: totalScanned,
        files_added: totalAdded,
        files_removed: totalRemoved,
      },
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (error) {
    log.task.error('Artifact scan all task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Scan all task failed: ${error.message}` };
  }
};

/**
 * Execute scan specific location task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeArtifactScanLocationTask = async metadataJson => {
  log.task.debug('Artifact scan location task starting');

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

    const { storage_location_id, verify_checksums = false, remove_orphaned = false } = metadata;

    log.task.debug('Scan location task parameters', {
      storage_location_id,
      verify_checksums,
      remove_orphaned,
    });

    const location = await ArtifactStorageLocation.findByPk(storage_location_id);
    if (!location) {
      return {
        success: false,
        error: `Storage location not found: ${storage_location_id}`,
      };
    }

    const scanResult = await scanStorageLocation(location, {
      verify_checksums,
      remove_orphaned,
    });

    await location.update({
      last_scan_at: new Date(),
      scan_errors: 0,
      last_error_message: null,
    });

    log.task.info('Storage location scan completed', {
      location_id: location.id,
      location_name: location.name,
      files_scanned: scanResult.scanned,
      files_added: scanResult.added,
      files_removed: scanResult.removed,
    });

    return {
      success: true,
      message: `Scan completed for ${location.name}: ${scanResult.scanned} files scanned, ${scanResult.added} added, ${scanResult.removed} removed`,
      stats: scanResult,
      location: {
        id: location.id,
        name: location.name,
        path: location.path,
      },
    };
  } catch (error) {
    log.task.error('Artifact scan location task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Scan location task failed: ${error.message}` };
  }
};
