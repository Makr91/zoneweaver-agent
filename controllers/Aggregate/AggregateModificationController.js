/**
 * @fileoverview Link aggregation modification endpoints — create, delete, and
 * link membership changes as async tasks.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../../lib/Logger.js';
import { executeCommand } from '../../lib/CommandManager.js';

/**
 * Validate that every named link exists as a physical interface (parallel —
 * one slow dladm answer never serializes the rest).
 * @param {string[]} links - Physical link names
 * @returns {Promise<string|null>} The first missing link, or null when all exist
 */
const findMissingPhysicalLink = async links => {
  const checks = await Promise.all(
    links.map(async link => ({
      link,
      exists: (await executeCommand(`pfexec dladm show-phys ${link}`)).success,
    }))
  );
  return checks.find(check => !check.exists)?.link || null;
};

/**
 * @swagger
 * /network/aggregates:
 *   post:
 *     summary: Create link aggregation
 *     description: Creates a new link aggregation using dladm create-aggr
 *     tags: [Link Aggregation]
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
 *               - links
 *             properties:
 *               name:
 *                 type: string
 *                 description: Aggregate link name
 *                 example: "aggr0"
 *               links:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Physical links to aggregate
 *                 example: ["e1000g0", "e1000g1"]
 *               policy:
 *                 type: string
 *                 enum: [L2, L3, L4, L2L3, L2L4, L3L4, L2L3L4]
 *                 description: Load balancing policy
 *                 default: "L4"
 *               lacp_mode:
 *                 type: string
 *                 enum: [off, active, passive]
 *                 description: LACP mode
 *                 default: "off"
 *               lacp_timer:
 *                 type: string
 *                 enum: [short, long]
 *                 description: LACP timer value
 *                 default: "short"
 *               unicast_address:
 *                 type: string
 *                 description: Fixed unicast address for the aggregate
 *                 example: "02:08:20:12:34:56"
 *               temporary:
 *                 type: boolean
 *                 description: Create temporary aggregate (not persistent)
 *                 default: false
 *     responses:
 *       202:
 *         description: Aggregate creation task created successfully
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
 *                 aggregate_name:
 *                   type: string
 *                 links:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: The aggregated links (echoed from the request)
 *                 policy:
 *                   type: string
 *                   description: The load-balancing policy (echoed from the request)
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create aggregate task
 */
export const createAggregate = async (req, res) => {
  try {
    const {
      name,
      links,
      policy = 'L4',
      lacp_mode = 'off',
      lacp_timer = 'short',
      unicast_address,
      temporary = false,
    } = req.body;

    // Validate required fields
    if (!name || !links || !Array.isArray(links) || links.length === 0) {
      return res.status(400).json({
        error: 'name and links array (with at least one link) are required',
      });
    }

    // Validate aggregate name format
    const aggrNameRegex = /^[a-zA-Z][a-zA-Z0-9_]*[0-9]+$/;
    if (!aggrNameRegex.test(name)) {
      return res.status(400).json({
        error:
          'Aggregate name must start with letter, contain alphanumeric/underscore, and end with number',
      });
    }

    // Validate policy
    const validPolicies = ['L2', 'L3', 'L4', 'L2L3', 'L2L4', 'L3L4', 'L2L3L4'];
    if (!validPolicies.includes(policy)) {
      return res.status(400).json({
        error: `Policy must be one of: ${validPolicies.join(', ')}`,
      });
    }

    // Validate LACP mode
    const validLacpModes = ['off', 'active', 'passive'];
    if (!validLacpModes.includes(lacp_mode)) {
      return res.status(400).json({
        error: `LACP mode must be one of: ${validLacpModes.join(', ')}`,
      });
    }

    // Validate LACP timer
    const validLacpTimers = ['short', 'long'];
    if (!validLacpTimers.includes(lacp_timer)) {
      return res.status(400).json({
        error: `LACP timer must be one of: ${validLacpTimers.join(', ')}`,
      });
    }

    // Validate unicast address format if provided
    if (unicast_address && !/^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(unicast_address)) {
      return res.status(400).json({
        error: 'unicast_address must be in format XX:XX:XX:XX:XX:XX',
      });
    }

    // Check if aggregate already exists
    const existsResult = await executeCommand(`pfexec dladm show-aggr ${name}`);
    if (existsResult.success) {
      return res.status(400).json({
        error: `Aggregate ${name} already exists`,
      });
    }

    // Validate that all links exist and are physical interfaces
    const missingLink = await findMissingPhysicalLink(links);
    if (missingLink) {
      return res.status(400).json({
        error: `Physical link ${missingLink} not found or not available`,
      });
    }

    // Create task for aggregate creation
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'create_aggregate',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            links,
            policy,
            lacp_mode,
            lacp_timer,
            unicast_address,
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
      message: `Aggregate creation task created for ${name}`,
      task_id: task.id,
      aggregate_name: name,
      links,
      policy,
    });
  } catch (error) {
    log.api.error('Error creating aggregate', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to create aggregate task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/aggregates/{aggregate}:
 *   delete:
 *     summary: Delete link aggregation
 *     description: Deletes a link aggregation using dladm delete-aggr
 *     tags: [Link Aggregation]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: aggregate
 *         required: true
 *         schema:
 *           type: string
 *         description: Aggregate name to delete
 *       - in: query
 *         name: temporary
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Delete only temporary configuration
 *     responses:
 *       202:
 *         description: Aggregate deletion task created successfully
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
 *                 aggregate_name:
 *                   type: string
 *                 temporary:
 *                   type: boolean
 *                   description: Whether only the temporary configuration was deleted (echoed from the request)
 *       404:
 *         description: Aggregate not found
 *       500:
 *         description: Failed to create aggregate deletion task
 */
export const deleteAggregate = async (req, res) => {
  log.api.debug('Aggregate deletion request starting', {
    aggregate: req.params.aggregate,
    query_params: req.query,
  });

  try {
    const { aggregate } = req.params;
    const { temporary = false } = req.query;

    log.api.debug('Aggregate deletion - parsed parameters', {
      aggregate,
      temporary,
    });

    // Check if aggregate exists
    log.api.debug('Checking if aggregate exists', { aggregate });
    const existsResult = await executeCommand(`pfexec dladm show-aggr ${aggregate}`);
    log.api.debug('Aggregate existence check result', {
      aggregate,
      exists: existsResult.success,
    });

    if (!existsResult.success) {
      log.api.warn('Aggregate not found', {
        aggregate,
        error: existsResult.error,
      });
      return res.status(404).json({
        error: `Aggregate ${aggregate} not found`,
        details: existsResult.error,
      });
    }

    log.api.debug('Aggregate exists, creating deletion task', { aggregate });

    // Create task for aggregate deletion
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'delete_aggregate',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            aggregate,
            temporary: temporary === 'true' || temporary === true,
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

    log.api.info('Aggregate deletion task created successfully', {
      task_id: task.id,
      aggregate,
      temporary: temporary === 'true' || temporary === true,
    });

    return res.status(202).json({
      success: true,
      message: `Aggregate deletion task created for ${aggregate}`,
      task_id: task.id,
      aggregate_name: aggregate,
      temporary: temporary === 'true' || temporary === true,
    });
  } catch (error) {
    log.api.error('Error deleting aggregate', {
      aggregate: req.params.aggregate,
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to create aggregate deletion task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/aggregates/{aggregate}/links:
 *   put:
 *     summary: Modify aggregate links
 *     description: Add or remove links from an existing aggregation using dladm add-aggr/remove-aggr
 *     tags: [Link Aggregation]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: aggregate
 *         required: true
 *         schema:
 *           type: string
 *         description: Aggregate name to modify
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
 *               temporary:
 *                 type: boolean
 *                 description: Temporary modification (not persistent)
 *                 default: false
 *     responses:
 *       202:
 *         description: Aggregate link modification task created successfully
 *       400:
 *         description: Invalid request parameters
 *       404:
 *         description: Aggregate not found
 *       500:
 *         description: Failed to create link modification task
 */
export const modifyAggregateLinks = async (req, res) => {
  try {
    const { aggregate } = req.params;
    const { operation, links, temporary = false } = req.body;

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

    // Check if aggregate exists
    const existsResult = await executeCommand(`pfexec dladm show-aggr ${aggregate}`);
    if (!existsResult.success) {
      return res.status(404).json({
        error: `Aggregate ${aggregate} not found`,
        details: existsResult.error,
      });
    }

    // If adding links, validate that they exist and are physical interfaces
    if (operation === 'add') {
      const missingLink = await findMissingPhysicalLink(links);
      if (missingLink) {
        return res.status(400).json({
          error: `Physical link ${missingLink} not found or not available`,
        });
      }
    }

    // Create task for aggregate link modification
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'modify_aggregate_links',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            aggregate,
            operation,
            links,
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
      message: `Aggregate link ${operation} task created for ${aggregate}`,
      task_id: task.id,
      aggregate_name: aggregate,
      operation,
      links,
      temporary,
    });
  } catch (error) {
    log.api.error('Error modifying aggregate links', {
      aggregate: req.params.aggregate,
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to create aggregate link modification task',
      details: error.message,
    });
  }
};
