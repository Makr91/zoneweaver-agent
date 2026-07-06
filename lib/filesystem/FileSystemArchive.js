/**
 * @fileoverview File System Archive Operations for Zoneweaver Agent
 * @description Archive creation and extraction for the file browser functionality
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import fs from 'fs/promises';
import path from 'path';
import config from '../../config/ConfigLoader.js';
import { executeCommand, validatePath } from './FileSystemCore.js';

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
