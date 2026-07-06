/**
 * @fileoverview Log File Controller for Zoneweaver Agent
 * @description Provides API endpoints for listing and reading system log files
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import fs from 'fs/promises';
import path from 'path';
import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';
import {
  execProm,
  formatFileSize,
  isFilePermitted,
  isBinaryFile,
  getLogType,
  findLogFile,
  validateLogFileAccess,
  formatDateForGrep,
} from './SystemLogsUtils.js';

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
