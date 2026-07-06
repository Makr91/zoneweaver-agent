/**
 * @fileoverview VNIC modification operations
 */

import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../../lib/Logger.js';
import { executeCommand } from './utils/CommandHelper.js';

/**
 * @swagger
 * /network/vnics:
 *   post:
 *     summary: Create VNIC
 *     description: Creates a new VNIC using dladm create-vnic
 *     tags: [VNIC Management]
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
 *               - link
 *             properties:
 *               name:
 *                 type: string
 *                 description: VNIC name
 *                 example: "vnic0"
 *               link:
 *                 type: string
 *                 description: Underlying physical link or etherstub
 *                 example: "e1000g0"
 *               mac_address:
 *                 type: string
 *                 enum: [auto, random, factory]
 *                 description: MAC address assignment method or specific MAC
 *                 default: "auto"
 *                 example: "auto"
 *               mac_prefix:
 *                 type: string
 *                 description: MAC prefix for random assignment (requires mac_address=random)
 *                 example: "02:08:20"
 *               slot:
 *                 type: integer
 *                 description: Factory MAC slot number (requires mac_address=factory)
 *                 example: 1
 *               vlan_id:
 *                 type: integer
 *                 description: VLAN ID for tagged traffic
 *                 minimum: 1
 *                 maximum: 4094
 *                 example: 100
 *               temporary:
 *                 type: boolean
 *                 description: Create temporary VNIC (not persistent)
 *                 default: false
 *               properties:
 *                 type: object
 *                 description: Additional link properties to set
 *                 example: {"maxbw": "100M", "priority": "high"}
 *               created_by:
 *                 type: string
 *                 description: User creating this VNIC
 *                 default: "api"
 *     responses:
 *       202:
 *         description: VNIC creation task created successfully
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
 *                 vnic_name:
 *                   type: string
 *                 underlying_link:
 *                   type: string
 *                   description: The physical link/etherstub the VNIC is created over (echoed from the request)
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create VNIC task
 */
export const createVNIC = async (req, res) => {
  const {
    name,
    link,
    mac_address = 'auto',
    mac_prefix,
    slot,
    vlan_id,
    temporary = false,
    properties = {},
    created_by = 'api',
  } = req.body;

  try {
    // Validate required fields
    if (!name || !link) {
      return res.status(400).json({
        error: 'name and link are required',
      });
    }

    // Validate VNIC name format
    const vnicNameRegex = /^[a-zA-Z][a-zA-Z0-9_]*[0-9]+$/;
    if (!vnicNameRegex.test(name)) {
      return res.status(400).json({
        error:
          'VNIC name must start with letter, contain alphanumeric/underscore, and end with number',
      });
    }

    // Validate MAC address method
    if (mac_address === 'factory' && slot === undefined) {
      return res.status(400).json({
        error: 'slot is required when mac_address is factory',
      });
    }

    if (
      mac_address === 'random' &&
      mac_prefix &&
      !/^(?:[0-9a-fA-F]{2}:){2}[0-9a-fA-F]{2}$/.test(mac_prefix)
    ) {
      return res.status(400).json({
        error: 'mac_prefix must be in format XX:XX:XX when specified',
      });
    }

    // Validate VLAN ID
    if (vlan_id !== undefined && (vlan_id < 1 || vlan_id > 4094)) {
      return res.status(400).json({
        error: 'vlan_id must be between 1 and 4094',
      });
    }

    // Check if VNIC already exists
    const existsResult = await executeCommand(`pfexec dladm show-vnic ${name}`);
    if (existsResult.success) {
      return res.status(400).json({
        error: `VNIC ${name} already exists`,
      });
    }

    // Prepare metadata object
    const metadataObject = {
      name,
      link,
      mac_address,
      mac_prefix,
      slot,
      vlan_id,
      temporary,
      properties,
    };

    log.api.debug('VNIC Controller - Creating task with metadata', {
      metadata_object: metadataObject,
    });

    const metadataJson = await new Promise((resolve, reject) => {
      yj.stringifyAsync(metadataObject, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    log.api.debug('Metadata stringified', {
      metadata_length: metadataJson.length,
    });

    // Create task for VNIC creation
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'create_vnic',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: metadataJson,
    });

    log.api.info('VNIC Controller - Task created successfully', {
      task_id: task.id,
      task_metadata_type: typeof task.metadata,
    });

    return res.status(202).json({
      success: true,
      message: `VNIC creation task created for ${name}`,
      task_id: task.id,
      vnic_name: name,
      underlying_link: link,
    });
  } catch (error) {
    log.api.error('Error creating VNIC', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to create VNIC task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/vnics/{vnic}:
 *   delete:
 *     summary: Delete VNIC
 *     description: Deletes a VNIC using dladm delete-vnic
 *     tags: [VNIC Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: vnic
 *         required: true
 *         schema:
 *           type: string
 *         description: VNIC name to delete
 *       - in: query
 *         name: temporary
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Delete only temporary configuration
 *       - in: query
 *         name: created_by
 *         schema:
 *           type: string
 *           default: "api"
 *         description: User deleting this VNIC
 *     responses:
 *       202:
 *         description: VNIC deletion task created successfully
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
 *                 vnic_name:
 *                   type: string
 *                 temporary:
 *                   type: boolean
 *                   description: Whether only the temporary configuration was deleted (echoed from the request)
 *       404:
 *         description: VNIC not found
 *       500:
 *         description: Failed to create VNIC deletion task
 */
export const deleteVNIC = async (req, res) => {
  const { vnic } = req.params;
  const { temporary = false, created_by = 'api' } = req.query;

  log.api.debug('VNIC deletion request starting', {
    vnic,
    query_params: req.query,
  });

  try {
    log.api.debug('VNIC deletion - parsed parameters', {
      vnic,
      temporary,
      created_by,
    });

    // Check if VNIC exists
    log.api.debug('Checking if VNIC exists', { vnic });
    const existsResult = await executeCommand(`pfexec dladm show-vnic ${vnic}`);
    log.api.debug('VNIC existence check result', {
      vnic,
      exists: existsResult.success,
    });

    if (!existsResult.success) {
      log.api.warn('VNIC not found', {
        vnic,
        error: existsResult.error,
      });
      return res.status(404).json({
        error: `VNIC ${vnic} not found`,
        details: existsResult.error,
      });
    }

    log.api.debug('VNIC exists, creating deletion task', { vnic });

    // Create task for VNIC deletion
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'delete_vnic',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            vnic,
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

    log.api.info('VNIC deletion task created successfully', {
      task_id: task.id,
      vnic,
      temporary: temporary === 'true' || temporary === true,
    });

    log.api.debug('VNIC deletion response sent successfully', { vnic });

    return res.status(202).json({
      success: true,
      message: `VNIC deletion task created for ${vnic}`,
      task_id: task.id,
      vnic_name: vnic,
      temporary: temporary === 'true' || temporary === true,
    });
  } catch (error) {
    log.api.error('Error deleting VNIC', {
      vnic,
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to create VNIC deletion task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/vnics/{vnic}/properties:
 *   put:
 *     summary: Set VNIC properties
 *     description: Sets link properties for a specific VNIC using dladm set-linkprop
 *     tags: [VNIC Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: vnic
 *         required: true
 *         schema:
 *           type: string
 *         description: VNIC name
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - properties
 *             properties:
 *               properties:
 *                 type: object
 *                 description: Properties to set (key-value pairs)
 *                 example: {"maxbw": "100M", "priority": "high"}
 *               temporary:
 *                 type: boolean
 *                 description: Set properties temporarily (not persistent)
 *                 default: false
 *               created_by:
 *                 type: string
 *                 description: User setting these properties
 *                 default: "api"
 *     responses:
 *       202:
 *         description: VNIC property update task created successfully
 *       400:
 *         description: Invalid properties
 *       404:
 *         description: VNIC not found
 *       500:
 *         description: Failed to create property update task
 */
export const setVNICProperties = async (req, res) => {
  const { vnic } = req.params;
  const { properties, temporary = false, created_by = 'api' } = req.body;

  try {
    if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) {
      return res.status(400).json({
        error: 'properties object is required and must contain at least one property',
      });
    }

    // Check if VNIC exists
    const existsResult = await executeCommand(`pfexec dladm show-vnic ${vnic}`);
    if (!existsResult.success) {
      return res.status(404).json({
        error: `VNIC ${vnic} not found`,
        details: existsResult.error,
      });
    }

    // Create task for VNIC property update
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'set_vnic_properties',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            vnic,
            properties,
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
      message: `VNIC property update task created for ${vnic}`,
      task_id: task.id,
      vnic_name: vnic,
      properties,
      temporary,
    });
  } catch (error) {
    log.api.error('Error setting VNIC properties', {
      vnic,
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to create VNIC property update task',
      details: error.message,
    });
  }
};
