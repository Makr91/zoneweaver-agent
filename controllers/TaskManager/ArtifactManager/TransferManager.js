import yj from 'yieldable-json';
import path from 'path';
import { log, createTimer } from '../../../lib/Logger.js';
import { moveItem, copyItem } from '../../../lib/FileSystemManager.js';
import Artifact from '../../../models/ArtifactModel.js';
import ArtifactStorageLocation from '../../../models/ArtifactStorageLocationModel.js';
import { coreDb as db } from '../../../config/Database.js';

/**
 * Transfer Manager for Artifacts
 * Handles moving and copying artifacts between storage locations
 */

/**
 * Execute artifact move task
 * @param {string} metadataJson - Task metadata as JSON string
 * @param {Object} task - The task row (progress updates write it directly)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeArtifactMoveTask = async (metadataJson, task) => {
  const taskTimer = createTimer('artifact_move_task');
  let transaction;

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
    const { artifact_id, destination_storage_location_id } = metadata;

    log.task.info('Artifact move task started', { artifact_id, destination_storage_location_id });

    const updateProgress = async (percent, status, info = {}) => {
      if (task) {
        try {
          await task.update({
            progress_percent: percent,
            progress_info: await new Promise((resolve, reject) => {
              yj.stringifyAsync({ status, ...info }, (err, result) => {
                if (err) {
                  reject(err);
                } else {
                  resolve(result);
                }
              });
            }),
          });
          log.task.debug('Progress updated', { task_id: task.id, percent, status });
        } catch (error) {
          log.task.warn('Failed to update progress', { error: error.message });
        }
      }
    };

    await updateProgress(10, 'validating_request');

    const artifact = await Artifact.findByPk(artifact_id);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifact_id}`);
    }

    const sourceLocation = await ArtifactStorageLocation.findByPk(artifact.storage_location_id);
    const destLocation = await ArtifactStorageLocation.findByPk(destination_storage_location_id);

    if (!sourceLocation || !destLocation) {
      throw new Error('Source or destination storage location not found.');
    }
    if (sourceLocation.id === destLocation.id) {
      throw new Error('Source and destination locations cannot be the same.');
    }
    if (artifact.file_type !== destLocation.type) {
      throw new Error(
        `Artifact type '${artifact.file_type}' does not match destination type '${destLocation.type}'.`
      );
    }

    const newPath = path.join(destLocation.path, artifact.filename);
    await updateProgress(30, 'moving_file', {
      source: artifact.path,
      destination: newPath,
    });

    await moveItem(artifact.path, newPath);

    await updateProgress(70, 'updating_database_records');

    transaction = await db.transaction();

    await artifact.update(
      {
        path: newPath,
        storage_location_id: destLocation.id,
        last_verified: new Date(),
      },
      { transaction }
    );

    await sourceLocation.decrement({ file_count: 1, total_size: artifact.size }, { transaction });
    await destLocation.increment({ file_count: 1, total_size: artifact.size }, { transaction });

    await transaction.commit();

    await updateProgress(100, 'completed');

    const duration = taskTimer.end();
    log.task.info('Artifact move task completed successfully', {
      artifact_id,
      duration_ms: duration,
    });

    return {
      success: true,
      message: `Successfully moved '${artifact.filename}' to '${destLocation.name}'.`,
    };
  } catch (error) {
    if (transaction) {
      await transaction.rollback();
    }
    log.task.error('Artifact move task failed', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Move failed: ${error.message}` };
  }
};

/**
 * Execute artifact copy task
 * @param {string} metadataJson - Task metadata as JSON string
 * @param {Object} task - The task row (progress updates write it directly)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeArtifactCopyTask = async (metadataJson, task) => {
  const taskTimer = createTimer('artifact_copy_task');
  let transaction;

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
    const { artifact_id, destination_storage_location_id } = metadata;

    log.task.info('Artifact copy task started', { artifact_id, destination_storage_location_id });

    const updateProgress = async (percent, status, info = {}) => {
      if (task) {
        try {
          await task.update({
            progress_percent: percent,
            progress_info: await new Promise((resolve, reject) => {
              yj.stringifyAsync({ status, ...info }, (err, result) => {
                if (err) {
                  reject(err);
                } else {
                  resolve(result);
                }
              });
            }),
          });
          log.task.debug('Progress updated', { task_id: task.id, percent, status });
        } catch (error) {
          log.task.warn('Failed to update progress', { error: error.message });
        }
      }
    };

    await updateProgress(10, 'validating_request');

    const sourceArtifact = await Artifact.findByPk(artifact_id);
    if (!sourceArtifact) {
      throw new Error(`Source artifact not found: ${artifact_id}`);
    }

    const destLocation = await ArtifactStorageLocation.findByPk(destination_storage_location_id);
    if (!destLocation) {
      throw new Error('Destination storage location not found.');
    }
    if (sourceArtifact.storage_location_id === destLocation.id) {
      throw new Error('Source and destination locations cannot be the same.');
    }
    if (sourceArtifact.file_type !== destLocation.type) {
      throw new Error(
        `Artifact type '${sourceArtifact.file_type}' does not match destination type '${destLocation.type}'.`
      );
    }

    const newPath = path.join(destLocation.path, sourceArtifact.filename);
    await updateProgress(30, 'copying_file', {
      source: sourceArtifact.path,
      destination: newPath,
    });

    await copyItem(sourceArtifact.path, newPath);

    await updateProgress(70, 'creating_new_database_record');

    transaction = await db.transaction();

    const newArtifact = await Artifact.create(
      {
        ...sourceArtifact.get({ plain: true }),
        id: undefined, // Let Sequelize generate a new UUID
        path: newPath,
        storage_location_id: destLocation.id,
        discovered_at: new Date(),
        last_verified: new Date(),
        createdAt: undefined,
        updatedAt: undefined,
      },
      { transaction }
    );

    await destLocation.increment(
      { file_count: 1, total_size: sourceArtifact.size },
      { transaction }
    );

    await transaction.commit();

    await updateProgress(100, 'completed');

    const duration = taskTimer.end();
    log.task.info('Artifact copy task completed successfully', {
      source_artifact_id: artifact_id,
      new_artifact_id: newArtifact.id,
      duration_ms: duration,
    });

    return {
      success: true,
      message: `Successfully copied '${sourceArtifact.filename}' to '${destLocation.name}'.`,
      new_artifact_id: newArtifact.id,
    };
  } catch (error) {
    if (transaction) {
      await transaction.rollback();
    }
    log.task.error('Artifact copy task failed', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Copy failed: ${error.message}` };
  }
};
