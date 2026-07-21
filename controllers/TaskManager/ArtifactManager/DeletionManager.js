import { parseAsync } from '../../../lib/AsyncJson.js';
import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import fs from 'fs';
import ArtifactStorageLocation from '../../../models/ArtifactStorageLocationModel.js';
import Artifact from '../../../models/ArtifactModel.js';
import { Op } from 'sequelize';

/**
 * Deletion Manager for Artifact Deletions
 * Handles artifact file and folder deletion operations
 */

/**
 * Process artifact deletion results and generate summary
 * @param {Array} artifacts - Original artifacts array
 * @param {Array} fileResults - File deletion results
 * @param {Array} artifactIds - Artifact IDs array
 * @returns {Object} Processing summary
 */
export const processArtifactDeletionResults = (artifacts, fileResults, artifactIds) => {
  const errors = [];
  let filesDeleted = 0;

  if (fileResults.length > 0) {
    filesDeleted = fileResults.filter(r => r.success).length;
    fileResults
      .filter(r => !r.success)
      .forEach(r => {
        errors.push(r.error);
      });
  }

  const recordsRemoved = artifactIds.length;
  const successCount = artifacts.length - errors.length;

  return { errors, filesDeleted, recordsRemoved, successCount };
};

/**
 * Execute artifact file deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeArtifactDeleteFileTask = async metadataJson => {
  log.task.debug('Artifact delete file task starting');

  try {
    const metadata = await parseAsync(metadataJson);

    const { artifact_ids, delete_files = true, force = false } = metadata;

    log.task.debug('Delete file task parameters', {
      artifact_count: artifact_ids.length,
      delete_files,
      force,
    });

    const artifacts = await Artifact.findAll({
      where: { id: artifact_ids },
      include: [
        {
          model: ArtifactStorageLocation,
          as: 'storage_location',
        },
      ],
    });

    if (artifacts.length === 0) {
      return {
        success: false,
        error: 'No artifacts found for the provided IDs',
      };
    }

    // Prepare parallel operations
    const fileDeletePromises = [];
    const artifactIds = [];
    const storageLocationUpdates = new Map();

    // First pass: prepare operations (no await)
    for (const artifact of artifacts) {
      // Prepare file deletion if requested
      if (delete_files && fs.existsSync(artifact.path)) {
        const command = force ? `pfexec rm -f "${artifact.path}"` : `pfexec rm "${artifact.path}"`;

        fileDeletePromises.push(
          executeCommand(command)
            .then(result => {
              if (result.success) {
                log.task.debug('Deleted artifact file', {
                  filename: artifact.filename,
                  path: artifact.path,
                });
                return { success: true, filename: artifact.filename };
              }
              throw new Error(`Failed to delete ${artifact.filename}: ${result.error}`);
            })
            .catch(error => {
              log.task.warn('Artifact file deletion failed', {
                artifact_id: artifact.id,
                filename: artifact.filename,
                error: error.message,
              });
              return { success: false, filename: artifact.filename, error: error.message };
            })
        );
      } else if (delete_files) {
        log.task.warn('Artifact file not found on disk', {
          filename: artifact.filename,
          path: artifact.path,
        });
      }

      // Collect artifact IDs for bulk database deletion
      artifactIds.push(artifact.id);

      // Aggregate storage location updates
      if (artifact.storage_location) {
        const locationId = artifact.storage_location.id;
        if (!storageLocationUpdates.has(locationId)) {
          storageLocationUpdates.set(locationId, {
            location: artifact.storage_location,
            file_count: 0,
            total_size: 0,
          });
        }
        const update = storageLocationUpdates.get(locationId);
        update.file_count += 1;
        update.total_size += artifact.size;
      }
    }

    // Second pass: Execute all operations in parallel
    const operations = [];

    // Add file deletion promises
    if (fileDeletePromises.length > 0) {
      operations.push(Promise.all(fileDeletePromises));
    }

    // Add bulk database deletion
    if (artifactIds.length > 0) {
      operations.push(
        Artifact.destroy({
          where: { id: { [Op.in]: artifactIds } },
        })
      );
    }

    // Add storage location updates
    const locationUpdatePromises = Array.from(storageLocationUpdates.values()).map(async update => {
      await update.location.decrement('file_count', { by: update.file_count });
      await update.location.decrement('total_size', { by: update.total_size });
    });
    if (locationUpdatePromises.length > 0) {
      operations.push(Promise.all(locationUpdatePromises));
    }

    // Execute all operations in parallel
    const results = await Promise.all(operations);

    // Process results using helper function
    const fileResults = fileDeletePromises.length > 0 ? results[0] || [] : [];
    const { errors, filesDeleted, recordsRemoved, successCount } = processArtifactDeletionResults(
      artifacts,
      fileResults,
      artifactIds
    );

    if (errors.length > 0 && errors.length === artifacts.length) {
      return {
        success: false,
        error: `Failed to delete all ${artifacts.length} artifacts`,
        errors,
      };
    }

    let message = `Successfully deleted ${successCount}/${artifacts.length} artifacts`;

    if (delete_files) {
      message += ` (${filesDeleted} files removed from disk)`;
    }

    if (errors.length > 0) {
      message += ` (${errors.length} had errors)`;
    }

    log.task.info('Artifact deletion completed', {
      total_artifacts: artifacts.length,
      successful_deletions: successCount,
      files_deleted: filesDeleted,
      records_removed: recordsRemoved,
      errors_count: errors.length,
    });

    return {
      success: true,
      message,
      stats: {
        total_artifacts: artifacts.length,
        successful_deletions: successCount,
        files_deleted: filesDeleted,
        records_removed: recordsRemoved,
      },
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (error) {
    log.task.error('Artifact delete file task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Delete file task failed: ${error.message}` };
  }
};

/**
 * Execute artifact folder deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeArtifactDeleteFolderTask = async metadataJson => {
  log.task.debug('Artifact delete folder task starting');

  try {
    const metadata = await parseAsync(metadataJson);

    const {
      storage_location_id,
      recursive = true,
      remove_db_records = true,
      force = false,
    } = metadata;

    log.task.debug('Delete folder task parameters', {
      storage_location_id,
      recursive,
      remove_db_records,
      force,
    });

    const location = await ArtifactStorageLocation.findByPk(storage_location_id);
    if (!location) {
      return {
        success: false,
        error: `Storage location not found: ${storage_location_id}`,
      };
    }

    log.task.info('Starting folder deletion', {
      location_name: location.name,
      location_path: location.path,
      recursive,
      remove_db_records,
    });

    let removedRecords = 0;

    // Remove database records first if requested
    if (remove_db_records) {
      const artifacts = await Artifact.findAll({
        where: { storage_location_id: location.id },
      });

      removedRecords = artifacts.length;
      if (removedRecords > 0) {
        await Artifact.destroy({
          where: { storage_location_id: location.id },
        });
        log.task.info('Removed artifact database records', {
          count: removedRecords,
        });
      }
    }

    // Delete physical folder and contents
    let command = `pfexec rm`;

    if (recursive && force) {
      command += ` -rf`;
    } else if (recursive) {
      command += ` -r`;
    } else if (force) {
      command += ` -f`;
    }

    command += ` "${location.path}"/*`; // Delete contents, not the folder itself

    const result = await executeCommand(command);

    if (result.success || (force && result.error.includes('No such file'))) {
      // Count as success even if no files were found (empty directory)
      log.task.info('Folder contents deleted successfully');

      // Reset location stats
      await location.update({
        file_count: 0,
        total_size: 0,
        last_scan_at: new Date(),
        scan_errors: 0,
        last_error_message: null,
      });

      return {
        success: true,
        message: `Successfully deleted folder contents for ${location.name}${remove_db_records ? ` (${removedRecords} database records removed)` : ''}`,
        location: {
          name: location.name,
          path: location.path,
        },
        stats: {
          removed_records: removedRecords,
          folder_cleared: true,
        },
      };
    }

    return {
      success: false,
      error: `Failed to delete folder contents: ${result.error}`,
    };
  } catch (error) {
    log.task.error('Artifact delete folder task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Delete folder task failed: ${error.message}` };
  }
};
