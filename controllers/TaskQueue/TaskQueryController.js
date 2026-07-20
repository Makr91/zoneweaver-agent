import Tasks from '../../models/TaskModel.js';
import { Op } from 'sequelize';
import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';
import { taskOutputManager } from '../../lib/TaskOutputManager.js';
import { runningTasks } from './TaskState.js';

/**
 * @fileoverview Task query controllers - list, details, and output retrieval
 */

/**
 * The converged structured-JSON wire (2026-07-20): task rows serve
 * `metadata` as a REAL JSON object (null when absent/unparseable) — storage
 * stays TEXT, the parse happens at the wire.
 * @param {*} value - Stored metadata column value
 * @returns {Object|null}
 */
const parseMetadataColumn = value => {
  if (value && typeof value === 'object') {
    return value;
  }
  if (typeof value !== 'string' || value === '') {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/**
 * @swagger
 * /tasks:
 *   get:
 *     summary: List tasks
 *     description: Retrieves a list of tasks with optional filtering
 *     tags: [Task Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, prepared, running, completed, completed_with_errors, failed, cancelled]
 *         description: Filter by task status
 *       - in: query
 *         name: machine_name
 *         schema:
 *           type: string
 *         description: Filter by machine name
 *       - in: query
 *         name: operation
 *         schema:
 *           type: string
 *         description: Filter by operation type
 *       - in: query
 *         name: operation_ne
 *         schema:
 *           type: string
 *         description: Exclude tasks with a specific operation type.
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Return tasks created since this timestamp.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of tasks to return
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [created_at, priority, status, machine_name, operation, started_at, completed_at]
 *           default: created_at
 *         description: Column to sort results by
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [ASC, DESC]
 *           default: DESC
 *         description: Sort direction (ascending or descending)
 *     responses:
 *       200:
 *         description: Tasks retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tasks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Task'
 *                 total:
 *                   type: integer
 *                 running_count:
 *                   type: integer
 */
export const listTasks = async (req, res) => {
  try {
    const zonesConfig = config.getZones();
    const defaultLimit = zonesConfig.default_pagination_limit || 50;
    const {
      limit = defaultLimit,
      status,
      machine_name,
      operation,
      operation_ne,
      since,
      include_count,
      min_priority,
      parent_task_id,
      sort,
      order: sortOrder,
    } = req.query;
    const whereClause = {};

    if (status) {
      whereClause.status = status;
    }
    if (machine_name) {
      whereClause.zone_name = machine_name;
    }
    if (operation) {
      whereClause.operation = operation;
    }
    if (operation_ne) {
      whereClause.operation = { [Op.ne]: operation_ne };
    }
    if (min_priority) {
      whereClause.priority = { [Op.gte]: parseInt(min_priority) };
    }
    if (parent_task_id) {
      whereClause.parent_task_id = parent_task_id;
    }
    if (since) {
      // Fix: Use updatedAt instead of created_at for incremental updates
      whereClause.updatedAt = { [Op.gte]: new Date(since) };
    }

    const validSortColumns = [
      'created_at',
      'priority',
      'status',
      'machine_name',
      'operation',
      'started_at',
      'completed_at',
    ];
    const requestedSort = validSortColumns.includes(sort) ? sort : 'created_at';
    // Wire sort value machine_name maps to the internal zone_name column
    const sortColumn = requestedSort === 'machine_name' ? 'zone_name' : requestedSort;
    const sortDirection = sortOrder?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // The LIST never carries the output column (joint contract with the Go
    // agent) — full task output rides GET /tasks/{taskId}/output only.
    const rows = await Tasks.findAll({
      where: whereClause,
      attributes: { exclude: ['output'] },
      order: [[sortColumn, sortDirection]],
      limit: parseInt(limit),
    });
    const tasks = rows.map(row => {
      const plain = row.get({ plain: true });
      plain.metadata = parseMetadataColumn(plain.metadata);
      return plain;
    });

    // Only run expensive count query if explicitly requested
    const response = {
      tasks,
      running_count: runningTasks.size,
    };

    // Add total count only if requested (for performance)
    if (include_count === 'true') {
      const total = await Tasks.count({ where: whereClause });
      response.total = total;
    }

    res.json(response);
  } catch (error) {
    log.database.error('Database error listing tasks', {
      error: error.message,
      stack: error.stack,
      query_params: req.query,
    });
    res.status(500).json({ error: 'Failed to retrieve tasks' });
  }
};

/**
 * @swagger
 * /tasks/{taskId}:
 *   get:
 *     summary: Get task details
 *     description: Retrieves detailed information about a specific task
 *     tags: [Task Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema:
 *           type: string
 *         description: Task ID
 *     responses:
 *       200:
 *         description: Task details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Task'
 *       404:
 *         description: Task not found
 */
export const getTaskDetails = async (req, res) => {
  try {
    const { taskId } = req.params;

    const task = await Tasks.findByPk(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const plain = task.get({ plain: true });
    plain.metadata = parseMetadataColumn(plain.metadata);
    plain.output = null;
    return res.json(plain);
  } catch (error) {
    log.database.error('Database error getting task details', {
      error: error.message,
      stack: error.stack,
      task_id: req.params.taskId,
    });
    return res.status(500).json({ error: 'Failed to retrieve task details' });
  }
};

/**
 * @swagger
 * /tasks/{taskId}/output:
 *   get:
 *     summary: Get task output
 *     description: Retrieves the output for a specific task (live from memory if running, from DB if completed)
 *     tags: [Task Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema:
 *           type: string
 *         description: Task ID
 *     responses:
 *       200:
 *         description: Task output retrieved successfully
 *       404:
 *         description: Task not found
 */
export const getTaskOutput = async (req, res) => {
  try {
    const { taskId } = req.params;

    const task = await Tasks.findByPk(taskId, { attributes: ['id', 'status'] });
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const output = await taskOutputManager.getOutput(taskId);

    return res.json({
      task_id: taskId,
      status: task.status,
      output,
    });
  } catch (error) {
    log.database.error('Failed to retrieve task output', {
      error: error.message,
      task_id: req.params.taskId,
    });
    return res.status(500).json({ error: 'Failed to retrieve task output' });
  }
};
