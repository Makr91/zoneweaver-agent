/**
 * @fileoverview File System Mutation Operations for Zoneweaver Agent
 * @description Filesystem-changing operations — write, create directory, delete, move, and copy
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import config from '../../config/ConfigLoader.js';
import { log } from '../Logger.js';
import { executeCommand, validatePath } from './FileSystemCore.js';

/**
 * Write file content
 * @param {string} filePath - File path to write
 * @param {string} content - Content to write
 * @param {Object} options - Write options
 * @returns {Promise<void>}
 */
export const writeFileContent = async (filePath, content, options = {}) => {
  const validation = validatePath(filePath);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const { normalizedPath } = validation;
  const fileBrowserConfig = config.getFileBrowser();

  try {
    // Check content size limit
    const maxEditSizeMB = fileBrowserConfig.security.max_edit_size_mb;
    const maxEditSizeBytes = maxEditSizeMB * 1024 * 1024;
    const contentSizeBytes = Buffer.byteLength(content, 'utf8');

    if (contentSizeBytes > maxEditSizeBytes) {
      throw new Error(
        `Content size ${Math.round(contentSizeBytes / 1024 / 1024)}MB exceeds edit limit of ${maxEditSizeMB}MB`
      );
    }

    // Create backup if file exists
    if (options.backup && fsSync.existsSync(normalizedPath)) {
      const backupPath = `${normalizedPath}.backup.${Date.now()}`;
      const backupResult = await executeCommand(`pfexec cp "${normalizedPath}" "${backupPath}"`);
      if (!backupResult.success) {
        log.filesystem.warn('Failed to create backup', {
          file_path: normalizedPath,
          backup_path: backupPath,
          error: backupResult.error,
        });
      }
    }

    // Use pfexec to write file for elevated privileges
    const escapedContent = content.replace(/'/g, "'\\''");
    const writeResult = await executeCommand(
      `echo '${escapedContent}' | pfexec tee "${normalizedPath}"`
    );

    if (!writeResult.success) {
      throw new Error(writeResult.error);
    }

    // Set ownership if specified
    if (options.uid !== undefined || options.gid !== undefined) {
      const uid = options.uid !== undefined ? options.uid : -1;
      const gid = options.gid !== undefined ? options.gid : -1;
      const chownResult = await executeCommand(`pfexec chown ${uid}:${gid} "${normalizedPath}"`);
      if (!chownResult.success) {
        log.filesystem.warn('Failed to set ownership', {
          file_path: normalizedPath,
          uid,
          gid,
          error: chownResult.error,
        });
      }
    }

    // Set permissions if specified
    if (options.mode !== undefined) {
      const chmodResult = await executeCommand(
        `pfexec chmod ${options.mode.toString(8)} "${normalizedPath}"`
      );
      if (!chmodResult.success) {
        log.filesystem.warn('Failed to set permissions', {
          file_path: normalizedPath,
          mode: options.mode.toString(8),
          error: chmodResult.error,
        });
      }
    }
  } catch (error) {
    throw new Error(`Failed to write file: ${error.message}`);
  }
};

/**
 * Create directory
 * @param {string} dirPath - Directory path to create
 * @param {Object} options - Creation options
 * @returns {Promise<void>}
 */
export const createDirectory = async (dirPath, options = {}) => {
  const validation = validatePath(dirPath);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const { normalizedPath } = validation;

  try {
    // Use pfexec mkdir for elevated privileges
    let command = `pfexec mkdir`;

    if (options.recursive) {
      command += ` -p`;
    }

    command += ` "${normalizedPath}"`;

    const result = await executeCommand(command);
    if (!result.success) {
      if (result.error.includes('File exists')) {
        throw new Error('Directory already exists');
      }
      throw new Error(result.error);
    }

    // Set permissions if specified
    if (options.mode !== undefined) {
      const chmodResult = await executeCommand(
        `pfexec chmod ${options.mode.toString(8)} "${normalizedPath}"`
      );
      if (!chmodResult.success) {
        log.filesystem.warn('Failed to set directory permissions', {
          directory_path: normalizedPath,
          mode: options.mode.toString(8),
          error: chmodResult.error,
        });
      }
    }

    // Set ownership if specified
    if (options.uid !== undefined || options.gid !== undefined) {
      const uid = options.uid !== undefined ? options.uid : -1;
      const gid = options.gid !== undefined ? options.gid : -1;
      const chownResult = await executeCommand(`pfexec chown ${uid}:${gid} "${normalizedPath}"`);
      if (!chownResult.success) {
        log.filesystem.warn('Failed to set directory ownership', {
          directory_path: normalizedPath,
          uid,
          gid,
          error: chownResult.error,
        });
      }
    }
  } catch (error) {
    throw new Error(`Failed to create directory: ${error.message}`);
  }
};

/**
 * Delete file or directory
 * @param {string} targetPath - Path to delete
 * @param {Object} options - Deletion options
 * @returns {Promise<void>}
 */
export const deleteItem = async (targetPath, options = {}) => {
  const validation = validatePath(targetPath);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const { normalizedPath } = validation;

  try {
    const stats = await fs.stat(normalizedPath);
    let command;

    if (stats.isDirectory()) {
      command = `pfexec rm`;
      if (options.recursive && options.force) {
        command += ` -rf`;
      } else if (options.recursive) {
        command += ` -r`;
      } else if (options.force) {
        command += ` -df`;
      } else {
        command += ` -d`;
      }
      command += ` "${normalizedPath}"`;
    } else {
      command = `pfexec rm`;
      if (options.force) {
        command += ` -f`;
      }
      command += ` "${normalizedPath}"`;
    }

    const result = await executeCommand(command);
    if (!result.success) {
      throw new Error(result.error);
    }
  } catch (error) {
    throw new Error(`Failed to delete item: ${error.message}`);
  }
};

/**
 * Move/rename item
 * @param {string} sourcePath - Source path
 * @param {string} destPath - Destination path
 * @param {Function} progressCallback - Optional progress callback for large files
 * @returns {Promise<void>}
 */
export const moveItem = async (sourcePath, destPath, progressCallback = null) => {
  const sourceValidation = validatePath(sourcePath);
  if (!sourceValidation.valid) {
    throw new Error(`Source path error: ${sourceValidation.error}`);
  }

  const destValidation = validatePath(destPath);
  if (!destValidation.valid) {
    throw new Error(`Destination path error: ${destValidation.error}`);
  }

  try {
    const stats = await fs.stat(sourceValidation.normalizedPath);
    const isLargeFile = stats.size > 100 * 1024 * 1024; // 100MB threshold SHOULD NOT BE HARDCODED SHOULD USE CONFIG.YAML REMOVE COMMENT AFTER FIXING

    if (isLargeFile && progressCallback) {
      // For large files, use pv for progress tracking (copy then delete)
      log.filesystem.info('Using pv for large file move operation', {
        source: sourceValidation.normalizedPath,
        destination: destValidation.normalizedPath,
        size_mb: Math.round(stats.size / 1024 / 1024),
      });

      // First check if pv is available
      const pvCheck = await executeCommand('which pv');

      if (pvCheck.success) {
        // Use pv to copy with progress, then delete source
        const pvCommand = `pfexec pv "${sourceValidation.normalizedPath}" > "${destValidation.normalizedPath}"`;
        const copyResult = await executeCommand(pvCommand, 1800000); // 30 min timeout for large files

        if (copyResult.success) {
          // Verify copy succeeded by checking file sizes
          const destStats = await fs.stat(destValidation.normalizedPath);
          if (destStats.size === stats.size) {
            // Copy successful, now remove source
            const rmResult = await executeCommand(`pfexec rm "${sourceValidation.normalizedPath}"`);
            if (!rmResult.success) {
              log.filesystem.warn('Failed to remove source after copy', {
                source: sourceValidation.normalizedPath,
                error: rmResult.error,
              });
            }
          } else {
            throw new Error('Copy verification failed - file sizes do not match');
          }
        } else {
          throw new Error(copyResult.error);
        }
      } else {
        // Fallback to regular mv if pv not available
        const result = await executeCommand(
          `pfexec mv "${sourceValidation.normalizedPath}" "${destValidation.normalizedPath}"`
        );
        if (!result.success) {
          throw new Error(result.error);
        }
      }
    } else {
      // Small files, directories, and callback-less moves: plain mv. Without
      // this branch the function silently did NOTHING and reported success.
      const result = await executeCommand(
        `pfexec mv "${sourceValidation.normalizedPath}" "${destValidation.normalizedPath}"`
      );
      if (!result.success) {
        throw new Error(result.error);
      }
    }
  } catch (error) {
    throw new Error(`Failed to move item: ${error.message}`);
  }
};

/**
 * Copy item
 * @param {string} sourcePath - Source path
 * @param {string} destPath - Destination path
 * @param {Function} progressCallback - Optional progress callback for large files
 * @returns {Promise<void>}
 */
export const copyItem = async (sourcePath, destPath, progressCallback = null) => {
  const sourceValidation = validatePath(sourcePath);
  if (!sourceValidation.valid) {
    throw new Error(`Source path error: ${sourceValidation.error}`);
  }

  const destValidation = validatePath(destPath);
  if (!destValidation.valid) {
    throw new Error(`Destination path error: ${destValidation.error}`);
  }

  try {
    const stats = await fs.stat(sourceValidation.normalizedPath);
    const isLargeFile = stats.size > 100 * 1024 * 1024; // 100MB threshold SHOULD NOT BE HARDCODED SHOULD USE CONFIG.YAML REMOVE COMMENT AFTER FIXING

    if (stats.isDirectory()) {
      // For directories, use regular cp -r
      const command = `pfexec cp -r "${sourceValidation.normalizedPath}" "${destValidation.normalizedPath}"`;
      const result = await executeCommand(command);
      if (!result.success) {
        throw new Error(result.error);
      }
    } else if (isLargeFile && progressCallback) {
      // For large files, use pv for progress tracking
      log.filesystem.info('Using pv for large file copy operation', {
        source: sourceValidation.normalizedPath,
        destination: destValidation.normalizedPath,
        size_mb: Math.round(stats.size / 1024 / 1024),
      });

      // First check if pv is available
      const pvCheck = await executeCommand('which pv');

      if (pvCheck.success) {
        // Use pv to copy with progress reporting
        const pvCommand = `pfexec pv "${sourceValidation.normalizedPath}" > "${destValidation.normalizedPath}"`;
        const copyResult = await executeCommand(pvCommand, 1800000); // 30 min timeout for large files SHOULD NOT BE HARDCODED SHOULD USE CONFIG.YAML REMOVE COMMENT AFTER FIXING

        if (copyResult.success) {
          // Verify copy succeeded by checking file sizes
          const destStats = await fs.stat(destValidation.normalizedPath);
          if (destStats.size !== stats.size) {
            throw new Error('Copy verification failed - file sizes do not match');
          }
        } else {
          throw new Error(copyResult.error);
        }
      } else {
        // Fallback to regular cp if pv not available
        const result = await executeCommand(
          `pfexec cp "${sourceValidation.normalizedPath}" "${destValidation.normalizedPath}"`
        );
        if (!result.success) {
          throw new Error(result.error);
        }
      }
    } else {
      // For small files, use regular cp
      const command = `pfexec cp "${sourceValidation.normalizedPath}" "${destValidation.normalizedPath}"`;
      const result = await executeCommand(command);
      if (!result.success) {
        throw new Error(result.error);
      }
    }
  } catch (error) {
    throw new Error(`Failed to copy item: ${error.message}`);
  }
};
