/**
 * @fileoverview Etherstub Management Controller for Zoneweaver Agent
 * @description Handles etherstub creation, deletion, and management via dladm commands
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import Tasks, { TaskPriority } from '../models/TaskModel.js';
import NetworkInterfaces from '../models/NetworkInterfaceModel.js';
import os from 'os';
import { stringifyAsync } from '../lib/AsyncJson.js';
import { log } from '../lib/Logger.js';
import { executeCommand } from '../lib/CommandManager.js';

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
 *                 returned:
 *                   type: integer
 *                   description: Number of records in this response
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
 *                 temporary:
 *                   type: boolean
 *                   description: Whether the etherstub is temporary (echoed from the request)
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create etherstub task
 */
export const createEtherstub = async (req, res) => {
  const { name, temporary = false } = req.body;

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
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        name,
        temporary,
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
 *                 temporary:
 *                   type: boolean
 *                   description: Whether only the temporary configuration was deleted (echoed from the request)
 *                 force:
 *                   type: boolean
 *                   description: Whether deletion was forced despite existing VNICs (echoed from the request)
 *       400:
 *         description: VNICs still exist on the etherstub (delete them first or pass force=true)
 *       404:
 *         description: Etherstub not found
 *       500:
 *         description: Failed to create etherstub deletion task
 */
export const deleteEtherstub = async (req, res) => {
  const { etherstub } = req.params;
  const { temporary = false, force = false } = req.query;

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
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        etherstub,
        temporary: temporary === 'true' || temporary === true,
        force: forceParam,
      }),
    });

    log.app.info('Etherstub deletion task created', {
      task_id: task.id,
      etherstub,
      temporary: temporary === 'true' || temporary === true,
      force: forceParam,
      created_by: req.entity.name,
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
