/**
 * @fileoverview Fault Manager Log Controller for Zoneweaver Agent
 * @description Provides API endpoints for viewing fault manager logs via fmdump
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';
import { execProm } from './SystemLogsUtils.js';

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
