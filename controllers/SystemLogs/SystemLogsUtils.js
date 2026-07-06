/**
 * @fileoverview System Logs shared utilities for Zoneweaver Agent
 * @description Shared helpers for log file discovery, validation, and formatting
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import fs from 'fs/promises';
import path from 'path';

export const execProm = util.promisify(exec);

/**
 * Helper function to format file size
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted file size
 */
export const formatFileSize = bytes => {
  const sizes = ['B', 'KB', 'MB', 'GB'];
  if (bytes === 0) {
    return '0 B';
  }
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(2)} ${sizes[i]}`;
};

/**
 * Helper function to check if file is permitted based on security rules
 * @param {string} filename - File name
 * @param {Object} logsConfig - System logs configuration
 * @returns {boolean} Whether file is permitted
 */
export const isFilePermitted = (filename, logsConfig) => {
  for (const pattern of logsConfig.security.forbidden_patterns) {
    const regex = new RegExp(pattern.replace('*', '.*'));
    if (regex.test(filename)) {
      return false;
    }
  }
  return true;
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
  } catch {
    // If we can't read the file, assume it's binary to be safe
    return true;
  }
};

/**
 * Helper function to determine log type from filename
 * @param {string} filename - Log file name
 * @returns {string} Log type
 */
export const getLogType = filename => {
  const name = filename.toLowerCase();

  if (name.includes('syslog')) {
    return 'system';
  }
  if (name.includes('message')) {
    return 'system';
  }
  if (name.includes('kern')) {
    return 'kernel';
  }
  if (name.includes('auth')) {
    return 'authentication';
  }
  if (name.includes('error')) {
    return 'error';
  }
  if (name.includes('debug')) {
    return 'debug';
  }
  if (name.includes('audit')) {
    return 'audit';
  }
  if (name.includes('sulog')) {
    return 'switch-user';
  }
  if (name.includes('wtmp') || name.includes('utmp')) {
    return 'login';
  }
  if (name.includes('zoneweaver')) {
    return 'application';
  }

  return 'other';
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

/**
 * Helper function to validate log file access
 * @param {string} logPath - Full path to log file
 * @param {Object} logsConfig - System logs configuration
 * @returns {Object} Validation result
 */
export const validateLogFileAccess = async (logPath, logsConfig) => {
  try {
    const stats = await fs.stat(logPath);

    // Check file size limit
    const maxSizeBytes = logsConfig.security.max_file_size_mb * 1024 * 1024;
    if (stats.size > maxSizeBytes) {
      return {
        allowed: false,
        reason: `File too large: ${formatFileSize(stats.size)} exceeds limit of ${logsConfig.security.max_file_size_mb}MB`,
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
 * Helper function to format date for grep pattern
 * @param {string} since - Since parameter
 * @returns {string|null} Grep-compatible date pattern or null
 */
export const formatDateForGrep = since => {
  try {
    const date = new Date(since);
    if (isNaN(date.getTime())) {
      return null;
    }

    // Format for common log timestamp patterns
    const monthNames = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const month = monthNames[date.getMonth()];
    const day = date.getDate().toString().padStart(2, ' ');

    // Return pattern that matches "Jan 19" format common in logs
    return `${month} ${day}`;
  } catch {
    return null;
  }
};
