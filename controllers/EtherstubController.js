/**
 * @fileoverview Etherstub Management Controller for Zoneweaver Agent
 * @description Handles etherstub creation, deletion, and management via dladm commands
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import NetworkInterfaces from '../models/NetworkInterfaceModel.js';
import yj from 'yieldable-json';
import os from 'os';
import { log } from '../lib/Logger.js';

const execPromise = util.promisify(exec);

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
const executeCommand = async command => {
  try {
    const { stdout } = await execPromise(command, {
      encoding: 'utf8',
      timeout: 30000, // 30 second timeout
    });
    return { success: true, output: stdout.trim() };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      output: error.stdout || '',
    };
  }
};

/**
 * @swagger
 * /network/etherstubs:
 *   get:
 *     summary: List etherstubs
 *     description: Returns etherstub information from monitoring data or live system query
 *     tags: [Etherstubs]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *         description: Filter by etherstub name
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of etherstubs to return
 *     responses:
 *       200:
 *         description: Etherstubs retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 etherstubs:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 source:
 *                   type: string
 *                   enum: [database, live]
 *       500:
 *         description: Failed to get etherstubs
 */
export const getEtherstubs = async (req, res) => {
  const { name, limit = 100 } = req.query;

  try {
    // Always get data from database (monitoring data)
    const hostname = os.hostname();
    const whereClause = {
      host: hostname,
      class: 'etherstub',
    };

    if (name) {
      whereClause.link = name;
    }

    // Optimize: Remove expensive COUNT query, frontend doesn't need it
    const rows = await NetworkInterfaces.findAll({
      where: whereClause,
      attributes: ['id', 'link', 'class', 'state', 'scan_timestamp'], // Selective fetching
      limit: parseInt(limit),
      order: [
        ['scan_timestamp', 'DESC'],
        ['link', 'ASC'],
      ],
    });

    return res.json({
      etherstubs: rows,
      source: 'database',
      returned: rows.length,
    });
  } catch (error) {
    log.api.error('Error getting etherstubs', {
      error: error.message,
      stack: error.stack,
      name,
    });
    return res.status(500).json({
      error: 'Failed to get etherstubs',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/etherstubs/{etherstub}:
 *   get:
 *     summary: Get etherstub details
 *     description: Returns detailed information about a specific etherstub
 *     tags: [Etherstubs]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: etherstub
 *         required: true
 *         schema:
 *           type: string
 *         description: Etherstub name
 *     responses:
 *       200:
 *         description: Etherstub details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       404:
 *         description: Etherstub not found
 *       500:
 *         description: Failed to get etherstub details
 */
export const getEtherstubDetails = async (req, res) => {
  const { etherstub } = req.params;

  try {
    // Always get data from database
    const hostname = os.hostname();
    const etherstubData = await NetworkInterfaces.findOne({
      where: {
        host: hostname,
        link: etherstub,
        class: 'etherstub',
      },
      order: [['scan_timestamp', 'DESC']],
    });

    if (!etherstubData) {
      return res.status(404).json({
        error: `Etherstub ${etherstub} not found`,
      });
    }

    return res.json(etherstubData);
  } catch (error) {
    log.api.error('Error getting etherstub details', {
      error: error.message,
      stack: error.stack,
      etherstub,
    });
    return res.status(500).json({
      error: 'Failed to get etherstub details',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/etherstubs:
 *   post:
 *     summary: Create etherstub
 *     description: Creates a new etherstub using dladm create-etherstub
 *     tags: [Etherstubs]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 description: Etherstub name
 *                 example: "stub0"
 *               temporary:
 *                 type: boolean
 *                 description: Create temporary etherstub (not persistent)
 *                 default: false
 *               created_by:
 *                 type: string
 *                 description: User creating this etherstub
 *                 default: "api"
 *     responses:
 *       202:
 *         description: Etherstub creation task created successfully
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
 *                 etherstub_name:
 *                   type: string
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create etherstub task
 */
export const createEtherstub = async (req, res) => {
  const { name, temporary = false, created_by = 'api' } = req.body;

  try {
    // Validate required fields
    if (!name) {
      return res.status(400).json({
        error: 'name is required',
      });
    }

    // Validate etherstub name format
    const stubNameRegex = /^[a-zA-Z][a-zA-Z0-9_]*$/;
    if (!stubNameRegex.test(name)) {
      return res.status(400).json({
        error:
          'Etherstub name must start with letter and contain only alphanumeric characters and underscores',
      });
    }

    // Check if etherstub already exists
    const existsResult = await executeCommand(`pfexec dladm show-etherstub ${name}`);
    if (existsResult.success) {
      return res.status(400).json({
        error: `Etherstub ${name} already exists`,
      });
    }

    // Create task for etherstub creation
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'create_etherstub',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            temporary,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Etherstub creation task created for ${name}`,
      task_id: task.id,
      etherstub_name: name,
      temporary,
    });
  } catch (error) {
    log.api.error('Error creating etherstub', {
      error: error.message,
      stack: error.stack,
      name,
    });
    return res.status(500).json({
      error: 'Failed to create etherstub task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/etherstubs/{etherstub}:
 *   delete:
 *     summary: Delete etherstub
 *     description: Deletes an etherstub using dladm delete-etherstub
 *     tags: [Etherstubs]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: etherstub
 *         required: true
 *         schema:
 *           type: string
 *         description: Etherstub name to delete
 *       - in: query
 *         name: temporary
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Delete only temporary configuration
 *       - in: query
 *         name: force
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Force deletion even if VNICs exist on etherstub
 *       - in: query
 *         name: created_by
 *         schema:
 *           type: string
 *           default: "api"
 *         description: User deleting this etherstub
 *     responses:
 *       202:
 *         description: Etherstub deletion task created successfully
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
 *                 etherstub_name:
 *                   type: string
 *       404:
 *         description: Etherstub not found
 *       500:
 *         description: Failed to create etherstub deletion task
 */
export const deleteEtherstub = async (req, res) => {
  const { etherstub } = req.params;
  const { temporary = false, force = false, created_by = 'api' } = req.query;

  try {
    // Check if etherstub exists
    const existsResult = await executeCommand(`pfexec dladm show-etherstub ${etherstub}`);

    if (!existsResult.success) {
      return res.status(404).json({
        error: `Etherstub ${etherstub} not found`,
        details: existsResult.error,
      });
    }

    // Check for VNICs on this etherstub unless force is specified
    const forceParam = force === 'true' || force === true;
    if (!forceParam) {
      const vnicResult = await executeCommand(`pfexec dladm show-vnic -l ${etherstub} -p -o link`);
      if (vnicResult.success && vnicResult.output.trim()) {
        const vnics = vnicResult.output.trim().split('\n');
        return res.status(400).json({
          error: `Cannot delete etherstub ${etherstub}. VNICs still exist on it: ${vnics.join(', ')}`,
          vnics,
          suggestion: 'Delete VNICs first or use force=true',
        });
      }
    }

    // Create task for etherstub deletion
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'delete_etherstub',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            etherstub,
            temporary: temporary === 'true' || temporary === true,
            force: forceParam,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    log.app.info('Etherstub deletion task created', {
      task_id: task.id,
      etherstub,
      temporary: temporary === 'true' || temporary === true,
      force: forceParam,
      created_by,
    });

    return res.status(202).json({
      success: true,
      message: `Etherstub deletion task created for ${etherstub}`,
      task_id: task.id,
      etherstub_name: etherstub,
      temporary: temporary === 'true' || temporary === true,
      force: forceParam,
    });
  } catch (error) {
    log.api.error('Error deleting etherstub', {
      error: error.message,
      stack: error.stack,
      etherstub,
    });
    return res.status(500).json({
      error: 'Failed to create etherstub deletion task',
      details: error.message,
    });
  }
};
