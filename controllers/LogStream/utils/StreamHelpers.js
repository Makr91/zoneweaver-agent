/**
 * @fileoverview Log stream helpers — shared session state, file access
 * validation, binary detection, and log file resolution.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import fs from 'fs/promises';
import path from 'path';
import { log } from '../../../lib/Logger.js';

/**
 * Active log stream sessions
 * @type {Map<string, Object>}
 */
export const activeSessions = new Map();

/**
 * Helper function to format file size
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted file size
 */
const formatFileSize = bytes => {
  const sizes = ['B', 'KB', 'MB', 'GB'];
  if (bytes === 0) {
    return '0 B';
  }
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(2)} ${sizes[i]}`;
};

/**
 * Helper function to validate log file access
 * @param {string} logPath - Full path to log file
 * @param {Object} logsConfig - System logs configuration
 * @returns {Object} Validation result
 */
export const validateLogFileAccess = async (logPath, logsConfig) => {
  try {
    const stats = await fs.stat(logPath);

    // Check file size limit (more generous for streaming)
    const maxSizeBytes = logsConfig.security.max_file_size_mb * 2 * 1024 * 1024; // 2x limit for streaming
    if (stats.size > maxSizeBytes) {
      return {
        allowed: false,
        reason: `File too large for streaming: ${formatFileSize(stats.size)} exceeds limit`,
      };
    }

    // Check forbidden patterns
    const filename = path.basename(logPath);
    for (const pattern of logsConfig.security.forbidden_patterns) {
      const regex = new RegExp(pattern.replace('*', '.*'));
      if (regex.test(filename) || regex.test(logPath)) {
        return {
          allowed: false,
          reason: `File matches forbidden pattern: ${pattern}`,
        };
      }
    }

    return {
      allowed: true,
      fileSize: stats.size,
      modified: stats.mtime,
    };
  } catch (error) {
    return {
      allowed: false,
      reason: `Cannot access file: ${error.message}`,
    };
  }
};

/**
 * Helper function to detect if a file is binary
 * @param {string} filePath - Full path to file
 * @returns {Promise<boolean>} True if file appears to be binary
 */
export const isBinaryFile = async filePath => {
  try {
    // Read first 8KB of file to check for binary content
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

    // Consider binary if >1% null bytes or high percentage of control characters
    if (nullPercentage > 0.01) {
      return true;
    }

    // Check for excessive control characters (excluding common ones like \n, \r, \t)
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
    // If we can't read the file, assume it's binary to be safe
    log.filesystem.warn('Cannot determine file type', {
      file_path: filePath,
      error: error.message,
    });
    return true;
  }
};

/**
 * Helper function to find log file in allowed paths
 * @param {string} logname - Log file name
 * @param {string[]} allowedPaths - Allowed directory paths
 * @returns {string|null} Full path to log file or null if not found
 */
export const findLogFile = async (logname, allowedPaths) => {
  const checks = await Promise.all(
    allowedPaths.map(async dirPath => {
      try {
        const fullPath = path.join(dirPath, logname);
        await fs.access(fullPath, fs.constants.R_OK);
        return fullPath;
      } catch {
        return null;
      }
    })
  );
  return checks.find(p => p !== null) || null;
};
