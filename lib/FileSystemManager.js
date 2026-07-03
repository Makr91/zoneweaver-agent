/**
 * @fileoverview File System Manager for Zoneweaver Agent
 * @description Provides secure filesystem operations for the file browser functionality
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import mimeTypes from 'mime-types';
import config from '../config/ConfigLoader.js';
import { log } from './Logger.js';

const execAsync = promisify(exec);

// ALL static limits should be configurable via config.yaml!!

/**
 * Get MIME type using mime-types package
 * @param {string} filePath - File path
 * @returns {string} MIME type
 */
export const getMimeType = filePath => {
  const mimeType = mimeTypes.lookup(filePath);
  return mimeType || 'application/octet-stream';
};

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @param {number} timeout - Timeout in milliseconds
 * timeout should be configurable! remove this comment after fixing
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
export const executeCommand = async (command, timeout = 30000) => {
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer ## Should be configurable, remove comment after fixing
    });

    if (stderr && stderr.trim()) {
      log.filesystem.warn('File command executed with stderr', {
        command: command.substring(0, 100),
        stderr: stderr.trim(),
      });
    }

    return {
      success: true,
      output: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      output: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
};

/**
 * Validate file path for security
 * @param {string} filePath - Path to validate
 * @returns {{valid: boolean, error?: string, normalizedPath?: string}}
 */
export const validatePath = filePath => {
  try {
    const fileBrowserConfig = config.getFileBrowser();

    if (!fileBrowserConfig?.enabled) {
      return { valid: false, error: 'File browser is disabled' };
    }

    // Normalize the path
    const normalizedPath = path.resolve(filePath);

    // Check for directory traversal
    if (fileBrowserConfig.security.prevent_traversal) {
      if (filePath.includes('..') || filePath.includes('~')) {
        return { valid: false, error: 'Directory traversal not allowed' };
      }
    }

    // Check forbidden paths
    for (const forbiddenPath of fileBrowserConfig.security.forbidden_paths) {
      if (normalizedPath.startsWith(forbiddenPath)) {
        return { valid: false, error: `Access to ${forbiddenPath} is forbidden` };
      }
    }

    // Check forbidden patterns
    for (const pattern of fileBrowserConfig.security.forbidden_patterns) {
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      if (regex.test(normalizedPath)) {
        return { valid: false, error: `Path matches forbidden pattern: ${pattern}` };
      }
    }

    return { valid: true, normalizedPath };
  } catch (error) {
    return { valid: false, error: `Path validation error: ${error.message}` };
  }
};

/**
 * Check if file is binary
 * @param {string} filePath - Path to file
 * @returns {Promise<boolean>} True if file appears to be binary
 */
export const isBinaryFile = async filePath => {
  try {
    const fileHandle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await fileHandle.read(buffer, 0, 8192, 0);
    await fileHandle.close();

    if (bytesRead === 0) {
      return false;
    } // Empty file, treat as text

    const sample = buffer.slice(0, bytesRead);

    // Count null bytes - binary files typically have many null bytes
    const nullBytes = sample.filter(byte => byte === 0).length;
    const nullPercentage = nullBytes / bytesRead;

    // Consider binary if >1% null bytes
    if (nullPercentage > 0.01) {
      return true;
    }

    // Check for excessive control characters
    const controlBytes = sample.filter(
      byte =>
        (byte >= 1 && byte <= 8) || // Control chars except \t
        (byte >= 11 && byte <= 12) || // Control chars except \n
        (byte >= 14 && byte <= 31) || // Control chars except \r
        byte === 127 // DEL
    ).length;

    const controlPercentage = controlBytes / bytesRead;

    // Consider binary if >5% control characters
    return controlPercentage > 0.05;
  } catch (error) {
    log.filesystem.warn('Cannot determine file type', {
      file_path: filePath,
      error: error.message,
    });
    return true; // Assume binary if we can't read it
  }
};

/**
 * Get file/directory information
 * @param {string} targetPath - Path to examine
 * @returns {Promise<Object>} File information object
 */
export const getItemInfo = async targetPath => {
  const validation = validatePath(targetPath);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const { normalizedPath } = validation;

  try {
    const stats = await fs.stat(normalizedPath);
    const isDirectory = stats.isDirectory();
    const name = path.basename(normalizedPath);

    let mimeType = null;
    let isBinary = false;
    let syntax = null;

    if (!isDirectory) {
      mimeType = getMimeType(normalizedPath);
      isBinary = await isBinaryFile(normalizedPath);

      // Determine syntax highlighting type for text files
      if (!isBinary) {
        const ext = path.extname(normalizedPath).toLowerCase();
        const syntaxMap = {
          '.js': 'javascript',
          '.json': 'json',
          '.py': 'python',
          '.sh': 'bash',
          '.yaml': 'yaml',
          '.yml': 'yaml',
          '.xml': 'xml',
          '.html': 'html',
          '.css': 'css',
          '.sql': 'sql',
          '.conf': 'apache',
          '.cfg': 'ini',
          '.ini': 'ini',
          '.log': 'log',
        };
        syntax = syntaxMap[ext] || 'text';
      }
    }

    // Get Unix permissions
    const { mode } = stats;
    const permissions = {
      octal: (mode & 0o777).toString(8),
      readable: (mode & 0o444) !== 0,
      writable: (mode & 0o222) !== 0,
      executable: (mode & 0o111) !== 0,
    };

    return {
      name,
      path: normalizedPath,
      isDirectory,
      size: isDirectory ? null : stats.size,
      mimeType,
      isBinary,
      syntax,
      permissions,
      uid: stats.uid,
      gid: stats.gid,
      atime: stats.atime,
      mtime: stats.mtime,
      ctime: stats.ctime,
      mode: stats.mode,
    };
  } catch (error) {
    throw new Error(`Failed to get item info: ${error.message}`);
  }
};

/**
 * List directory contents
 * @param {string} dirPath - Directory path to list
 * @returns {Promise<Array>} Array of file/directory objects
 */
export const listDirectory = async (dirPath = '/') => {
  const validation = validatePath(dirPath);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const { normalizedPath } = validation;

  try {
    const stats = await fs.stat(normalizedPath);
    if (!stats.isDirectory()) {
      throw new Error('Path is not a directory');
    }

    const entries = await fs.readdir(normalizedPath);
    const fileBrowserConfig = config.getFileBrowser();
    const maxEntries = fileBrowserConfig.security.max_directory_entries;

    if (entries.length > maxEntries) {
      throw new Error(`Directory has ${entries.length} entries, exceeding limit of ${maxEntries}`);
    }

    // Use Promise.all for parallel file info gathering (major performance improvement)
    const itemInfoPromises = entries.map(async entry => {
      try {
        const entryPath = path.join(normalizedPath, entry);
        return await getItemInfo(entryPath);
      } catch (error) {
        log.filesystem.warn('Failed to get file info during directory listing', {
          entry,
          directory: normalizedPath,
          error: error.message,
        });
        return null; // Return null for failed entries
      }
    });

    const itemResults = await Promise.all(itemInfoPromises);
    const items = itemResults.filter(item => item !== null); // Filter out failed entries

    // Sort directories first, then files, both alphabetically
    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) {
        return -1;
      }
      if (!a.isDirectory && b.isDirectory) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });

    return items;
  } catch (error) {
    throw new Error(`Failed to list directory: ${error.message}`);
  }
};

/**
 * Read file content
 * @param {string} filePath - File path to read
 * @returns {Promise<string>} File content
 */
export const readFileContent = async filePath => {
  const validation = validatePath(filePath);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const { normalizedPath } = validation;
  const fileBrowserConfig = config.getFileBrowser();

  try {
    const stats = await fs.stat(normalizedPath);

    if (stats.isDirectory()) {
      throw new Error('Cannot read directory as file');
    }

    // Check file size limit for editing
    const maxEditSizeMB = fileBrowserConfig.security.max_edit_size_mb;
    const maxEditSizeBytes = maxEditSizeMB * 1024 * 1024;

    if (stats.size > maxEditSizeBytes) {
      throw new Error(
        `File size ${Math.round(stats.size / 1024 / 1024)}MB exceeds edit limit of ${maxEditSizeMB}MB`
      );
    }

    // Check if file is binary
    const isBinary = await isBinaryFile(normalizedPath);
    if (isBinary) {
      throw new Error('Cannot read binary file as text');
    }

    const content = await fs.readFile(normalizedPath, 'utf8');
    return content;
  } catch (error) {
    throw new Error(`Failed to read file: ${error.message}`);
  }
};

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

/**
 * Create archive
 * @param {Array<string>} sourcePaths - Paths to archive
 * @param {string} archivePath - Archive destination path
 * @param {string} format - Archive format (zip, tar, tar.gz, etc.)
 * @returns {Promise<void>}
 */
export const createArchive = async (sourcePaths, archivePath, format) => {
  const fileBrowserConfig = config.getFileBrowser();

  if (!fileBrowserConfig.archive?.enabled) {
    throw new Error('Archive operations are disabled');
  }

  if (!fileBrowserConfig.archive.supported_formats.includes(format)) {
    throw new Error(`Unsupported archive format: ${format}`);
  }

  // Validate all source paths
  for (const sourcePath of sourcePaths) {
    const validation = validatePath(sourcePath);
    if (!validation.valid) {
      throw new Error(`Source path error: ${validation.error}`);
    }
  }

  const archiveValidation = validatePath(archivePath);
  if (!archiveValidation.valid) {
    throw new Error(`Archive path error: ${archiveValidation.error}`);
  }

  try {
    let command;
    const sourceList = sourcePaths.map(p => `"${validatePath(p).normalizedPath}"`).join(' ');
    const archiveDestination = archiveValidation.normalizedPath;

    switch (format) {
      case 'zip':
        command = `pfexec zip -r "${archiveDestination}" ${sourceList}`;
        break;
      case 'tar':
        command = `pfexec tar -cf "${archiveDestination}" ${sourceList}`;
        break;
      case 'tar.gz':
        command = `pfexec tar -czf "${archiveDestination}" ${sourceList}`;
        break;
      case 'tar.bz2':
        command = `pfexec tar -cjf "${archiveDestination}" ${sourceList}`;
        break;
      default:
        throw new Error(`Unsupported format: ${format}`);
    }

    const result = await executeCommand(command, 300000); // 5 minute timeout SHOULD NOT BE HARDCODED, should be configurable, remove this comment after fixing

    if (!result.success) {
      throw new Error(result.error);
    }

    // Check archive size limit
    const stats = await fs.stat(archiveDestination);
    const maxArchiveSizeMB = fileBrowserConfig.archive.max_archive_size_mb;
    const maxArchiveSizeBytes = maxArchiveSizeMB * 1024 * 1024;

    if (stats.size > maxArchiveSizeBytes) {
      // Clean up oversized archive
      await fs.unlink(archiveDestination);
      throw new Error(
        `Archive size ${Math.round(stats.size / 1024 / 1024)}MB exceeds limit of ${maxArchiveSizeMB}MB`
      );
    }
  } catch (error) {
    throw new Error(`Failed to create archive: ${error.message}`);
  }
};

/**
 * Extract archive
 * @param {string} archivePath - Archive file path
 * @param {string} extractPath - Extraction destination path
 * @returns {Promise<void>}
 */
export const extractArchive = async (archivePath, extractPath) => {
  const fileBrowserConfig = config.getFileBrowser();

  if (!fileBrowserConfig.archive?.enabled) {
    throw new Error('Archive operations are disabled');
  }

  const archiveValidation = validatePath(archivePath);
  if (!archiveValidation.valid) {
    throw new Error(`Archive path error: ${archiveValidation.error}`);
  }

  const extractValidation = validatePath(extractPath);
  if (!extractValidation.valid) {
    throw new Error(`Extract path error: ${extractValidation.error}`);
  }

  try {
    const normalizedArchivePath = archiveValidation.normalizedPath;
    const normalizedExtractPath = extractValidation.normalizedPath;

    // Detect format from extension
    let command;
    const ext = path.extname(normalizedArchivePath).toLowerCase();

    if (ext === '.zip') {
      command = `pfexec unzip -o "${normalizedArchivePath}" -d "${normalizedExtractPath}"`;
    } else if (ext === '.gz' && normalizedArchivePath.endsWith('.tar.gz')) {
      command = `pfexec tar -xzf "${normalizedArchivePath}" -C "${normalizedExtractPath}"`;
    } else if (ext === '.bz2' && normalizedArchivePath.endsWith('.tar.bz2')) {
      command = `pfexec tar -xjf "${normalizedArchivePath}" -C "${normalizedExtractPath}"`;
    } else if (ext === '.tar') {
      command = `pfexec tar -xf "${normalizedArchivePath}" -C "${normalizedExtractPath}"`;
    } else if (ext === '.gz') {
      command = `pfexec gunzip -c "${normalizedArchivePath}" > "${normalizedExtractPath}/${path.basename(normalizedArchivePath, '.gz')}"`;
    } else {
      throw new Error(`Unsupported archive format: ${ext}`);
    }

    const result = await executeCommand(command, 300000); // 5 minute timeout ## THIS SHOULD BE CONFIGURABLE VIA THE CONFIG.YAML!!!

    if (!result.success) {
      throw new Error(result.error);
    }
  } catch (error) {
    throw new Error(`Failed to extract archive: ${error.message}`);
  }
};
