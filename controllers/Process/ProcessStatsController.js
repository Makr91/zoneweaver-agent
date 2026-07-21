/**
 * @fileoverview Process Stats Controller for Zoneweaver Agent
 * @description Handles process resource limits, pattern search, and real-time statistics
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { getProcessLimits, findProcesses, getProcessStats } from '../../lib/ProcessManager.js';
import { log } from '../../lib/Logger.js';

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
