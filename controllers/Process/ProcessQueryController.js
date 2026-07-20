/**
 * @fileoverview Process Query Controller for Zoneweaver Agent
 * @description Handles API requests for OmniOS process listing, inspection, and statistics
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import {
  getProcesses,
  getProcessDetails,
  getProcessFiles,
  getProcessStack,
  getProcessLimits,
  findProcesses,
  getProcessStats,
} from '../../lib/ProcessManager.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * tags:
 *   name: Processes
 *   description: Manage and monitor system processes
 */

/**
 * @swagger
 * /system/processes:
 *   get:
 *     summary: List system processes
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: zone
 *         schema:
 *           type: string
 *         description: Filter processes by zone name
 *       - in: query
 *         name: user
 *         schema:
 *           type: string
 *         description: Filter processes by username
 *       - in: query
 *         name: command
 *         schema:
 *           type: string
 *         description: Filter processes by command pattern (regex)
 *       - in: query
 *         name: detailed
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include detailed CPU and memory statistics (instant response using ps auxww)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 1000
 *           default: 100
 *         description: Maximum number of processes to return
 *     responses:
 *       200:
 *         description: List of processes
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   pid:
 *                     type: integer
 *                     description: Process ID
 *                   ppid:
 *                     type: integer
 *                     description: Parent process ID
 *                   zone:
 *                     type: string
 *                     description: Zone name
 *                   username:
 *                     type: string
 *                     description: Process owner
 *                   command:
 *                     type: string
 *                     description: Command name
 *                   cpu_percent:
 *                     type: number
 *                     description: CPU usage percentage (if detailed=true)
 *                   memory_percent:
 *                     type: number
 *                     description: Memory usage percentage (if detailed=true)
 *                   vsz:
 *                     type: integer
 *                     description: Virtual memory size in KB (if detailed=true)
 *                   rss:
 *                     type: integer
 *                     description: Resident memory size in KB (if detailed=true)
 *                   state:
 *                     type: string
 *                     description: Process state (if detailed=true)
 *                   start_time:
 *                     type: string
 *                     description: Process start time (if detailed=true)
 *                   cpu_time:
 *                     type: string
 *                     description: Total CPU time used (if detailed=true)
 *       500:
 *         description: Failed to retrieve processes
 */
export const listProcesses = async (req, res) => {
  try {
    const options = {
      zone: req.query.zone,
      user: req.query.user,
      command: req.query.command,
      detailed: req.query.detailed === 'true',
      limit: req.query.limit ? parseInt(req.query.limit) : 100,
    };

    const processes = await getProcesses(options);
    return res.json(processes);
  } catch (error) {
    log.api.error('Error listing processes', {
      error: error.message,
      query_params: req.query,
    });
    return res.status(500).json({ error: 'Failed to retrieve processes' });
  }
};

/**
 * @swagger
 * /system/processes/{pid}:
 *   get:
 *     summary: Get detailed process information
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pid
 *         required: true
 *         schema:
 *           type: integer
 *         description: Process ID
 *     responses:
 *       200:
 *         description: Process details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pid:
 *                   type: integer
 *                 ppid:
 *                   type: integer
 *                 zone:
 *                   type: string
 *                 command:
 *                   type: string
 *                 vsz:
 *                   type: integer
 *                   description: Virtual memory size
 *                 rss:
 *                   type: integer
 *                   description: Resident memory size
 *                 open_files_sample:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Sample of open files, one pfiles line per entry (converged structured-JSON wire; [] when unavailable)
 *       404:
 *         description: Process not found
 *       500:
 *         description: Failed to retrieve process details
 */
export const getProcessDetailsController = async (req, res) => {
  try {
    const pid = parseInt(req.params.pid);
    if (isNaN(pid)) {
      return res.status(400).json({ error: 'Invalid process ID' });
    }

    const processInfo = await getProcessDetails(pid);
    return res.json(processInfo);
  } catch (error) {
    log.api.error('Error getting process details', {
      error: error.message,
      pid: req.params.pid,
    });
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to retrieve process details' });
  }
};

/**
 * @swagger
 * /system/processes/{pid}/files:
 *   get:
 *     summary: Get open files for process
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pid
 *         required: true
 *         schema:
 *           type: integer
 *         description: Process ID
 *     responses:
 *       200:
 *         description: List of open files
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   fd:
 *                     type: integer
 *                     description: File descriptor number
 *                   description:
 *                     type: string
 *                     description: File description
 *                   details:
 *                     type: string
 *                     description: Additional file details
 *       404:
 *         description: Process not found
 *       500:
 *         description: Failed to retrieve process files
 */
export const getProcessFilesController = async (req, res) => {
  try {
    const pid = parseInt(req.params.pid);
    if (isNaN(pid)) {
      return res.status(400).json({ error: 'Invalid process ID' });
    }

    const files = await getProcessFiles(pid);
    return res.json(files);
  } catch (error) {
    log.api.error('Error getting process files', {
      error: error.message,
      pid: req.params.pid,
    });
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to retrieve process files' });
  }
};

/**
 * @swagger
 * /system/processes/{pid}/stack:
 *   get:
 *     summary: Get process stack trace
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pid
 *         required: true
 *         schema:
 *           type: integer
 *         description: Process ID
 *     responses:
 *       200:
 *         description: Process stack trace
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *       404:
 *         description: Process not found
 *       500:
 *         description: Failed to retrieve stack trace
 */
export const getProcessStackController = async (req, res) => {
  try {
    const pid = parseInt(req.params.pid);
    if (isNaN(pid)) {
      return res.status(400).json({ error: 'Invalid process ID' });
    }

    const stackTrace = await getProcessStack(pid);
    return res.type('text/plain').send(stackTrace);
  } catch (error) {
    log.api.error('Error getting process stack', {
      error: error.message,
      pid: req.params.pid,
    });
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to retrieve stack trace' });
  }
};

/**
 * @swagger
 * /system/processes/{pid}/limits:
 *   get:
 *     summary: Get process resource limits
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pid
 *         required: true
 *         schema:
 *           type: integer
 *         description: Process ID
 *     responses:
 *       200:
 *         description: Process resource limits
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties:
 *                 type: string
 *       404:
 *         description: Process not found
 *       500:
 *         description: Failed to retrieve process limits
 */
export const getProcessLimitsController = async (req, res) => {
  try {
    const pid = parseInt(req.params.pid);
    if (isNaN(pid)) {
      return res.status(400).json({ error: 'Invalid process ID' });
    }

    const limits = await getProcessLimits(pid);
    return res.json(limits);
  } catch (error) {
    log.api.error('Error getting process limits', {
      error: error.message,
      pid: req.params.pid,
    });
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to retrieve process limits' });
  }
};

/**
 * @swagger
 * /system/processes/find:
 *   get:
 *     summary: Find processes by pattern
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: pattern
 *         required: true
 *         schema:
 *           type: string
 *         description: Process name pattern
 *       - in: query
 *         name: zone
 *         schema:
 *           type: string
 *         description: Filter by zone name
 *       - in: query
 *         name: user
 *         schema:
 *           type: string
 *         description: Filter by username
 *     responses:
 *       200:
 *         description: List of matching process IDs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pattern:
 *                   type: string
 *                 pids:
 *                   type: array
 *                   items:
 *                     type: integer
 *                 count:
 *                   type: integer
 *       400:
 *         description: Missing pattern parameter
 *       500:
 *         description: Failed to find processes
 */
export const findProcessesController = async (req, res) => {
  try {
    const { pattern, zone, user } = req.query;

    if (!pattern) {
      return res.status(400).json({ error: 'Pattern parameter is required' });
    }

    const options = {};
    if (zone) {
      options.zone = zone;
    }
    if (user) {
      options.user = user;
    }

    const pids = await findProcesses(pattern, options);
    return res.json({
      pattern,
      pids,
      count: pids.length,
      filters: options,
    });
  } catch (error) {
    log.api.error('Error finding processes', {
      error: error.message,
      pattern: req.query.pattern,
    });
    return res.status(500).json({ error: 'Failed to find processes' });
  }
};

/**
 * @swagger
 * /system/processes/stats:
 *   get:
 *     summary: Get real-time process statistics
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: zone
 *         schema:
 *           type: string
 *         description: Filter by zone name
 *       - in: query
 *         name: interval
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 60
 *           default: 1
 *         description: Update interval in seconds
 *       - in: query
 *         name: count
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 10
 *           default: 1
 *         description: Number of samples to collect
 *     responses:
 *       200:
 *         description: Process statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   pid:
 *                     type: integer
 *                   username:
 *                     type: string
 *                   cpu_percent:
 *                     type: number
 *                   size:
 *                     type: integer
 *                     nullable: true
 *                     description: Virtual size in BYTES (converged structured-JSON wire; null when unparseable)
 *                   rss:
 *                     type: integer
 *                     nullable: true
 *                     description: Resident size in BYTES
 *                   cpu_time:
 *                     type: integer
 *                     nullable: true
 *                     description: Total CPU time in SECONDS
 *                   command:
 *                     type: string
 *       500:
 *         description: Failed to retrieve process statistics
 */
export const getProcessStatsController = async (req, res) => {
  try {
    const options = {
      zone: req.query.zone,
      interval: req.query.interval ? parseInt(req.query.interval) : 1,
      count: req.query.count ? parseInt(req.query.count) : 1,
    };

    // Validate parameters
    if (options.interval < 1 || options.interval > 60) {
      return res.status(400).json({ error: 'Interval must be between 1 and 60 seconds' });
    }
    if (options.count < 1 || options.count > 10) {
      return res.status(400).json({ error: 'Count must be between 1 and 10' });
    }

    const stats = await getProcessStats(options);
    return res.json(stats);
  } catch (error) {
    log.api.error('Error getting process statistics', {
      error: error.message,
      query_params: req.query,
    });
    return res.status(500).json({ error: 'Failed to retrieve process statistics' });
  }
};
