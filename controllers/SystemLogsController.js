/**
 * @fileoverview System Logs Controller for Zoneweaver Agent
 * @description Provides API endpoints for viewing system and application logs
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import fs from 'fs/promises';
import path from 'path';
import config from '../config/ConfigLoader.js';
import { log } from '../lib/Logger.js';

const execProm = util.promisify(exec);

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
 * Helper function to check if file is permitted based on security rules
 * @param {string} filename - File name
 * @param {Object} logsConfig - System logs configuration
 * @returns {boolean} Whether file is permitted
 */
const isFilePermitted = (filename, logsConfig) => {
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
const isBinaryFile = async filePath => {
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
const getLogType = filename => {
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
const findLogFile = async (logname, allowedPaths) => {
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
const validateLogFileAccess = async (logPath, logsConfig) => {
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
const formatDateForGrep = since => {
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

/**
 * @swagger
 * /system/logs/list:
 *   get:
 *     summary: List available log files
 *     description: Returns list of available log files from configured directories
 *     tags: [System Logs]
 *     responses:
 *       200:
 *         description: Available log files
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 log_files:
 *                   type: array
 *                   items:
 *                     type: object
 *                 directories:
 *                   type: array
 *       500:
 *         description: Failed to list log files
 */
export const listLogFiles = async (req, res) => {
  void req;
  try {
    const logsConfig = config.getSystemLogs();

    if (!logsConfig?.enabled) {
      return res.status(503).json({
        error: 'System logs are disabled in configuration',
      });
    }

    const directoryPromises = logsConfig.allowed_paths.map(async allowedPath => {
      try {
        const dirStats = await fs.stat(allowedPath);
        if (!dirStats.isDirectory()) {
          return null;
        }

        const files = await fs.readdir(allowedPath, { withFileTypes: true });
        const dirInfo = {
          path: allowedPath,
          fileCount: 0,
          files: [],
        };

        const filePromises = files.map(async file => {
          if (!file.isFile() || !isFilePermitted(file.name, logsConfig)) {
            return null;
          }

          const fullPath = path.join(allowedPath, file.name);
          try {
            const stats = await fs.stat(fullPath);

            // Skip binary files entirely
            const isBinary = await isBinaryFile(fullPath);
            if (isBinary) {
              // Silently skip binary files - no need to log
              return null;
            }

            return {
              name: file.name,
              path: fullPath,
              relativePath: path.relative('/var', fullPath),
              size: stats.size,
              modified: stats.mtime,
              sizeFormatted: formatFileSize(stats.size),
              type: getLogType(file.name),
            };
          } catch {
            return null;
          }
        });

        const processedFiles = (await Promise.all(filePromises)).filter(f => f !== null);
        dirInfo.files = processedFiles;
        dirInfo.fileCount = processedFiles.length;

        return dirInfo;
      } catch (error) {
        log.filesystem.warn('Could not read log directory', {
          directory: allowedPath,
          error: error.message,
        });
        return null;
      }
    });

    const directories = (await Promise.all(directoryPromises)).filter(d => d !== null);
    const logFiles = directories.flatMap(d => d.files);

    return res.json({
      log_files: logFiles,
      directories,
      total_files: logFiles.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error listing log files', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to list log files',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/logs/{logname}:
 *   get:
 *     summary: Read system log file
 *     description: Returns contents of specified log file with filtering options
 *     tags: [System Logs]
 *     parameters:
 *       - in: path
 *         name: logname
 *         required: true
 *         schema:
 *           type: string
 *         description: Log file name (e.g., syslog, messages, authlog)
 *       - in: query
 *         name: lines
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Number of lines to return
 *       - in: query
 *         name: tail
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Read from end of file (tail) vs beginning
 *       - in: query
 *         name: grep
 *         schema:
 *           type: string
 *         description: Filter lines containing this pattern
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *         description: Show entries since this timestamp (for supported formats)
 *     responses:
 *       200:
 *         description: Log file contents
 *       404:
 *         description: Log file not found
 *       400:
 *         description: Invalid parameters or file too large
 *       500:
 *         description: Failed to read log file
 */
export const getLogFile = async (req, res) => {
  let logPath = null;
  try {
    const { logname } = req.params;
    const { lines = 100, tail = true, grep, since } = req.query;
    const logsConfig = config.getSystemLogs();

    if (!logsConfig?.enabled) {
      return res.status(503).json({
        error: 'System logs are disabled in configuration',
      });
    }

    // Find the log file in allowed paths
    logPath = await findLogFile(logname, logsConfig.allowed_paths);
    if (!logPath) {
      return res.status(404).json({
        error: `Log file '${logname}' not found in allowed directories`,
      });
    }

    // Security check - validate path and file size
    const securityCheck = await validateLogFileAccess(logPath, logsConfig);
    if (!securityCheck.allowed) {
      return res.status(400).json({
        error: securityCheck.reason,
      });
    }

    // Check if file is binary - refuse to read binary files
    const isBinary = await isBinaryFile(logPath);
    if (isBinary) {
      return res.status(400).json({
        error: `Cannot read log file '${logname}' - file contains binary data`,
        details: 'Binary files are not supported for log viewing',
        logname,
        suggestion: 'Use system tools like hexdump or strings for binary file analysis',
      });
    }

    // Build command to read log file
    let command = '';
    const requestedLines = Math.min(parseInt(lines) || 100, logsConfig.max_lines);

    if (tail) {
      command = `tail -n ${requestedLines} "${logPath}"`;
    } else {
      command = `head -n ${requestedLines} "${logPath}"`;
    }

    // Add grep filter if specified
    if (grep) {
      command += ` | grep "${grep.replace(/"/g, '\\"')}"`;
    }

    // Add since filter if specified (basic implementation)
    if (since) {
      // For logs with standard timestamp formats, use grep with date pattern
      const datePattern = formatDateForGrep(since);
      if (datePattern) {
        command += ` | grep -E "${datePattern}"`;
      }
    }

    const { stdout } = await execProm(command, {
      timeout: logsConfig.timeout * 1000,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    // Remove verbose stderr logging - most commands output to stderr even on success

    const logLines = stdout.split('\n').filter(line => line.trim());

    return res.json({
      logname,
      path: logPath,
      lines: logLines,
      totalLines: logLines.length,
      requestedLines,
      tail,
      filters: {
        grep: grep || null,
        since: since || null,
      },
      raw_output: stdout,
      fileInfo: {
        size: securityCheck.fileSize,
        sizeFormatted: formatFileSize(securityCheck.fileSize),
        modified: securityCheck.modified,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error reading log file', {
      error: error.message,
      stack: error.stack,
      logname: req.params.logname,
      path: logPath,
    });
    return res.status(500).json({
      error: 'Failed to read log file',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/logs/fault-manager/{type}:
 *   get:
 *     summary: Read fault manager logs
 *     description: Returns fault manager logs via fmdump
 *     tags: [System Logs]
 *     parameters:
 *       - in: path
 *         name: type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [faults, errors, info, info-hival]
 *         description: Type of fault manager log
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *         description: Show entries since this time
 *       - in: query
 *         name: class
 *         schema:
 *           type: string
 *         description: Filter by fault class pattern
 *       - in: query
 *         name: uuid
 *         schema:
 *           type: string
 *         description: Filter by specific UUID
 *       - in: query
 *         name: verbose
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Show verbose output
 *     responses:
 *       200:
 *         description: Fault manager log contents
 *       400:
 *         description: Invalid log type
 *       500:
 *         description: Failed to read fault manager logs
 */
export const getFaultManagerLogs = async (req, res) => {
  try {
    const { type } = req.params;
    const { since, class: faultClass, uuid, verbose = false } = req.query;
    const logsConfig = config.getSystemLogs();

    if (!logsConfig?.enabled) {
      return res.status(503).json({
        error: 'System logs are disabled in configuration',
      });
    }

    // Build fmdump command
    let command = 'fmdump';

    switch (type) {
      case 'faults':
        // Default - fault log
        break;
      case 'errors':
        command += ' -e';
        break;
      case 'info':
        command += ' -i';
        break;
      case 'info-hival':
        command += ' -I';
        break;
      default:
        return res.status(400).json({
          error: `Invalid log type: ${type}. Valid types: faults, errors, info, info-hival`,
        });
    }

    // Add options
    if (verbose) {
      command += ' -v';
    }
    if (since) {
      command += ` -t "${since}"`;
    }
    if (faultClass) {
      command += ` -c "${faultClass}"`;
    }
    if (uuid) {
      command += ` -u ${uuid}`;
    }

    const { stdout } = await execProm(command, {
      timeout: logsConfig.timeout * 1000,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    // Remove verbose stderr logging - fmdump outputs to stderr even on success

    const logLines = stdout.split('\n').filter(line => line.trim());

    return res.json({
      logType: type,
      lines: logLines,
      totalLines: logLines.length,
      filters: {
        since: since || null,
        class: faultClass || null,
        uuid: uuid || null,
        verbose,
      },
      command,
      raw_output: stdout,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error reading fault manager logs', {
      error: error.message,
      stack: error.stack,
      type: req.params.type,
    });
    return res.status(500).json({
      error: 'Failed to read fault manager logs',
      details: error.message,
    });
  }
};

export default {
  listLogFiles,
  getLogFile,
  getFaultManagerLogs,
};
