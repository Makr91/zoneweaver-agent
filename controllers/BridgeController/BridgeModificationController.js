/**
 * @fileoverview Bridge modification endpoints
 */

import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../../lib/Logger.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { validateBridgeParams } from './utils/ValidationHelper.js';

/**
 * @swagger
 * /network/bridges:
 *   post:
 *     summary: Create bridge
 *     description: Creates a new 802.1D bridge using dladm create-bridge
 *     tags: [Bridges]
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
 *                 description: Bridge name
 *                 example: "bridge0"
 *               protection:
 *                 type: string
 *                 enum: [stp, trill]
 *                 description: Protection method (STP or TRILL)
 *                 default: "stp"
 *               priority:
 *                 type: integer
 *                 minimum: 0
 *                 maximum: 61440
 *                 description: Bridge priority (0-61440, increments of 4096)
 *                 default: 32768
 *               max_age:
 *                 type: integer
 *                 minimum: 6
 *                 maximum: 40
 *                 description: Maximum age for configuration information (6-40 seconds)
 *                 default: 20
 *               hello_time:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 10
 *                 description: Hello time for BPDUs (1-10 seconds)
 *                 default: 2
 *               forward_delay:
 *                 type: integer
 *                 minimum: 4
 *                 maximum: 30
 *                 description: Forward delay timer (4-30 seconds)
 *                 default: 15
 *               force_protocol:
 *                 type: integer
 *                 minimum: 0
 *                 description: Forced maximum supported protocol version
 *                 default: 3
 *               links:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Links to add to the bridge
 *                 example: ["e1000g0", "e1000g1"]
 *     responses:
 *       202:
 *         description: Bridge creation task created successfully
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
 *                 bridge_name:
 *                   type: string
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create bridge task
 */
export const createBridge = async (req, res) => {
  const {
    name,
    protection = 'stp',
    priority = 32768,
    max_age = 20,
    hello_time = 2,
    forward_delay = 15,
    force_protocol = 3,
    links = [],
  } = req.body;

  try {
    const validationError = validateBridgeParams(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    // Check if bridge already exists
    const existsResult = await executeCommand(`pfexec dladm show-bridge ${name}`);
    if (existsResult.success) {
      return res.status(400).json({
        error: `Bridge ${name} already exists`,
      });
    }

    // Validate links if provided
    if (links && links.length > 0) {
      const results = await Promise.all(
        links.map(link => executeCommand(`pfexec dladm show-link ${link}`))
      );
      const failedLinkIndex = results.findIndex(r => !r.success);
      if (failedLinkIndex !== -1) {
        return res.status(400).json({
          error: `Link ${links[failedLinkIndex]} not found or not available`,
        });
      }
    }

    // Create task for bridge creation
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'create_bridge',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            protection,
            priority,
            max_age,
            hello_time,
            forward_delay,
            force_protocol,
            links,
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
      message: `Bridge creation task created for ${name}`,
      task_id: task.id,
      bridge_name: name,
      protection,
      links,
    });
  } catch (error) {
    log.api.error('Error creating bridge', {
      error: error.message,
      stack: error.stack,
      name,
      protection,
    });
    return res.status(500).json({
      error: 'Failed to create bridge task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/bridges/{bridge}:
 *   delete:
 *     summary: Delete bridge
 *     description: Deletes a bridge using dladm delete-bridge
 *     tags: [Bridges]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: bridge
 *         required: true
 *         schema:
 *           type: string
 *         description: Bridge name to delete
 *       - in: query
 *         name: force
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Force deletion even if links are attached
 *     responses:
 *       202:
 *         description: Bridge deletion task created successfully
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
 *                 bridge_name:
 *                   type: string
 *       404:
 *         description: Bridge not found
 *       500:
 *         description: Failed to create bridge deletion task
 */
export const deleteBridge = async (req, res) => {
  const { bridge } = req.params;
  const { force = false } = req.query;

  try {
    // Check if bridge exists
    const existsResult = await executeCommand(`pfexec dladm show-bridge ${bridge}`);

    if (!existsResult.success) {
      return res.status(404).json({
        error: `Bridge ${bridge} not found`,
        details: existsResult.error,
      });
    }

    // Check for attached links unless force is specified
    const forceParam = force === 'true' || force === true;
    if (!forceParam) {
      const linksResult = await executeCommand(`pfexec dladm show-bridge ${bridge} -l -p -o link`);
      if (linksResult.success && linksResult.output.trim()) {
        const attachedLinks = linksResult.output.trim().split('\n');
        return res.status(400).json({
          error: `Cannot delete bridge ${bridge}. Links are still attached: ${attachedLinks.join(', ')}`,
          attached_links: attachedLinks,
          suggestion: 'Remove links first or use force=true',
        });
      }
    }

    // Create task for bridge deletion
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'delete_bridge',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            bridge,
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

    log.app.info('Bridge deletion task created', {
      task_id: task.id,
      bridge,
      force: forceParam,
      created_by: req.entity.name,
    });

    return res.status(202).json({
      success: true,
      message: `Bridge deletion task created for ${bridge}`,
      task_id: task.id,
      bridge_name: bridge,
      force: forceParam,
    });
  } catch (error) {
    log.api.error('Error deleting bridge', {
      error: error.message,
      stack: error.stack,
      bridge,
    });
    return res.status(500).json({
      error: 'Failed to create bridge deletion task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/bridges/{bridge}/links:
 *   put:
 *     summary: Modify bridge links
 *     description: Add or remove links from an existing bridge using dladm add-bridge/remove-bridge
 *     tags: [Bridges]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: bridge
 *         required: true
 *         schema:
 *           type: string
 *         description: Bridge name to modify
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - operation
 *               - links
 *             properties:
 *               operation:
 *                 type: string
 *                 enum: [add, remove]
 *                 description: Whether to add or remove links
 *               links:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Links to add or remove
 *                 example: ["e1000g2", "e1000g3"]
 *     responses:
 *       202:
 *         description: Bridge link modification task created successfully
 *       400:
 *         description: Invalid request parameters
 *       404:
 *         description: Bridge not found
 *       500:
 *         description: Failed to create link modification task
 */
export const modifyBridgeLinks = async (req, res) => {
  const { bridge } = req.params;
  const { operation, links } = req.body;

  try {
    // Validate required fields
    if (!operation || !links || !Array.isArray(links) || links.length === 0) {
      return res.status(400).json({
        error: 'operation and links array (with at least one link) are required',
      });
    }

    // Validate operation
    if (!['add', 'remove'].includes(operation)) {
      return res.status(400).json({
        error: 'operation must be either "add" or "remove"',
      });
    }

    // Check if bridge exists
    const existsResult = await executeCommand(`pfexec dladm show-bridge ${bridge}`);
    if (!existsResult.success) {
      return res.status(404).json({
        error: `Bridge ${bridge} not found`,
        details: existsResult.error,
      });
    }

    // If adding links, validate that they exist
    if (operation === 'add') {
      const results = await Promise.all(
        links.map(link => executeCommand(`pfexec dladm show-link ${link}`))
      );
      const failedLinkIndex = results.findIndex(r => !r.success);
      if (failedLinkIndex !== -1) {
        return res.status(400).json({
          error: `Link ${links[failedLinkIndex]} not found or not available`,
        });
      }
    }

    // Create task for bridge link modification
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'modify_bridge_links',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            bridge,
            operation,
            links,
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
      message: `Bridge link ${operation} task created for ${bridge}`,
      task_id: task.id,
      bridge_name: bridge,
      operation,
      links,
    });
  } catch (error) {
    log.api.error('Error modifying bridge links', {
      error: error.message,
      stack: error.stack,
      bridge,
      operation,
    });
    return res.status(500).json({
      error: 'Failed to create bridge link modification task',
      details: error.message,
    });
  }
};
