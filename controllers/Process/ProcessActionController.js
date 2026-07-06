/**
 * @fileoverview Process Action Controller for Zoneweaver Agent
 * @description Handles API requests for OmniOS process signaling, killing, and tracing
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { signalProcess, killProcess, killProcessesByPattern } from '../../lib/ProcessManager.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/processes/{pid}/signal:
 *   post:
 *     summary: Send signal to process
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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               signal:
 *                 type: string
 *                 enum: [TERM, KILL, HUP, INT, USR1, USR2, STOP, CONT]
 *                 default: TERM
 *                 description: Signal to send
 *     responses:
 *       200:
 *         description: Signal sent successfully
 *       400:
 *         description: Invalid process ID or signal
 *       500:
 *         description: Failed to send signal
 */
export const sendSignalToProcess = async (req, res) => {
  try {
    const pid = parseInt(req.params.pid);
    if (isNaN(pid)) {
      return res.status(400).json({ error: 'Invalid process ID' });
    }

    const { signal = 'TERM' } = req.body;
    const result = await signalProcess(pid, signal);

    if (result.success) {
      return res.json({
        success: true,
        message: result.message,
        pid,
        signal,
      });
    }
    return res.status(500).json({ error: result.error });
  } catch (error) {
    log.api.error('Error sending signal to process', {
      error: error.message,
      pid: req.params.pid,
      signal: req.body.signal,
    });
    return res.status(500).json({ error: 'Failed to send signal to process' });
  }
};

/**
 * @swagger
 * /system/processes/{pid}/kill:
 *   post:
 *     summary: Kill a process
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
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               force:
 *                 type: boolean
 *                 default: false
 *                 description: If true, send SIGKILL immediately instead of SIGTERM first
 *     responses:
 *       200:
 *         description: Process killed successfully
 *       400:
 *         description: Invalid process ID
 *       500:
 *         description: Failed to kill process
 */
export const killProcessController = async (req, res) => {
  try {
    const pid = parseInt(req.params.pid);
    if (isNaN(pid)) {
      return res.status(400).json({ error: 'Invalid process ID' });
    }

    const { force = false } = req.body;
    const result = await killProcess(pid, force);

    if (result.success) {
      return res.json({
        success: true,
        message: result.message,
        pid,
        method: force ? 'SIGKILL' : 'SIGTERM',
      });
    }
    return res.status(500).json({ error: result.error });
  } catch (error) {
    log.api.error('Error killing process', {
      error: error.message,
      pid: req.params.pid,
      force: req.body.force,
    });
    return res.status(500).json({ error: 'Failed to kill process' });
  }
};

/**
 * @swagger
 * /system/processes/batch-kill:
 *   post:
 *     summary: Kill multiple processes by pattern
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - pattern
 *             properties:
 *               pattern:
 *                 type: string
 *                 description: Process name pattern
 *               zone:
 *                 type: string
 *                 description: Filter by zone name
 *               user:
 *                 type: string
 *                 description: Filter by username
 *               signal:
 *                 type: string
 *                 enum: [TERM, KILL, HUP, INT, USR1, USR2, STOP, CONT]
 *                 default: TERM
 *                 description: Signal to send
 *     responses:
 *       200:
 *         description: Batch kill results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 pattern:
 *                   type: string
 *                 killed:
 *                   type: array
 *                   items:
 *                     type: integer
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: object
 *                 message:
 *                   type: string
 *       400:
 *         description: Missing pattern parameter
 *       500:
 *         description: Failed to kill processes
 */
export const batchKillProcesses = async (req, res) => {
  try {
    const { pattern, zone, user, signal = 'TERM' } = req.body;

    if (!pattern) {
      return res.status(400).json({ error: 'Pattern parameter is required' });
    }

    const options = { signal };
    if (zone) {
      options.zone = zone;
    }
    if (user) {
      options.user = user;
    }

    const result = await killProcessesByPattern(pattern, options);

    return res.json({
      ...result,
      pattern,
      signal,
      filters: { zone, user },
    });
  } catch (error) {
    log.api.error('Error in batch kill processes', {
      error: error.message,
      pattern: req.body.pattern,
      signal: req.body.signal,
    });
    return res.status(500).json({ error: 'Failed to kill processes' });
  }
};

/**
 * @swagger
 * /system/processes/trace/start:
 *   post:
 *     summary: Start process tracing (async task)
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - pid
 *             properties:
 *               pid:
 *                 type: integer
 *                 description: Process ID to trace
 *               duration:
 *                 type: integer
 *                 minimum: 5
 *                 maximum: 300
 *                 default: 30
 *                 description: Trace duration in seconds
 *     responses:
 *       200:
 *         description: Tracing task created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 task_id:
 *                   type: string
 *                 pid:
 *                   type: integer
 *       400:
 *         description: Invalid parameters
 *       500:
 *         description: Failed to create tracing task
 */
export const startProcessTrace = async (req, res) => {
  try {
    const { pid, duration = 30 } = req.body;

    if (!pid || isNaN(parseInt(pid))) {
      return res.status(400).json({ error: 'Valid process ID is required' });
    }

    if (duration < 5 || duration > 300) {
      return res.status(400).json({ error: 'Duration must be between 5 and 300 seconds' });
    }

    // Create a task for the tracing operation
    const task = await Tasks.create({
      zone_name: `process-${pid}`,
      operation: 'process_trace',
      priority: TaskPriority.BACKGROUND,
      created_by: req.entity.name,
      status: 'pending',
      metadata: JSON.stringify({ pid, duration }),
    });

    return res.json({
      success: true,
      message: `Process trace task created for PID ${pid}`,
      task_id: task.id,
      pid: parseInt(pid),
      duration,
    });
  } catch (error) {
    log.database.error('Error creating process trace task', {
      error: error.message,
      pid: req.body.pid,
      duration: req.body.duration,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to create tracing task' });
  }
};
