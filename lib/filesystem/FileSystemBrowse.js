/**
 * @fileoverview File System Browse Operations for Zoneweaver Agent
 * @description Read-only filesystem operations — item info, directory listing, and file reading
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import fs from 'fs/promises';
import path from 'path';
import config from '../../config/ConfigLoader.js';
import { log } from '../Logger.js';
import { getMimeType, validatePath, isBinaryFile } from './FileSystemCore.js';

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
