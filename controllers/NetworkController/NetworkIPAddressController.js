/**
 * @fileoverview IP address modification operations
 */

import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../../lib/Logger.js';
import { executeCommand } from '../../lib/CommandManager.js';

/**
 * @swagger
 * /network/addresses:
 *   post:
 *     summary: Create IP address
 *     description: Creates a new IP address assignment using ipadm create-addr
 *     tags: [Network Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - interface
 *               - type
 *               - addrobj
 *             properties:
 *               interface:
 *                 type: string
 *                 description: Network interface name
 *                 example: "vnic0"
 *               type:
 *                 type: string
 *                 enum: [static, dhcp, addrconf]
 *                 description: Type of IP address to create
 *               addrobj:
 *                 type: string
 *                 description: Address object name (e.g., vnic0/v4static)
 *                 example: "vnic0/v4static"
 *               address:
 *                 type: string
 *                 description: IP address with prefix (required for static type)
 *                 example: "192.168.1.100/24"
 *               primary:
 *                 type: boolean
 *                 description: Set as primary interface (DHCP only)
 *                 default: false
 *               wait:
 *                 type: integer
 *                 description: Wait time in seconds for DHCP (DHCP only)
 *                 default: 30
 *               temporary:
 *                 type: boolean
 *                 description: Create temporary address (not persistent)
 *                 default: false
 *               down:
 *                 type: boolean
 *                 description: Create address in down state
 *                 default: false
 *     responses:
 *       202:
 *         description: IP address creation task created successfully
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
 *                 addrobj:
 *                   type: string
 *                 type:
 *                   type: string
 *                   description: The address type echoed from the request
 *                 interface:
 *                   type: string
 *                   description: The interface echoed from the request
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create IP address task
 */
export const createIPAddress = async (req, res) => {
  const {
    interface: iface,
    type,
    addrobj,
    address,
    primary = false,
    wait = 30,
    temporary = false,
    down = false,
  } = req.body;

  try {
    if (!iface || !type || !addrobj) {
      return res.status(400).json({
        error: 'interface, type, and addrobj are required',
      });
    }

    if (type === 'static' && !address) {
      return res.status(400).json({
        error: 'address is required for static type',
      });
    }

    if (!['static', 'dhcp', 'addrconf'].includes(type)) {
      return res.status(400).json({
        error: 'type must be one of: static, dhcp, addrconf',
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'create_ip_address',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            interface: iface,
            type,
            addrobj,
            address,
            primary,
            wait,
            temporary,
            down,
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
      message: `IP address creation task created for ${addrobj}`,
      task_id: task.id,
      addrobj,
      type,
      interface: iface,
    });
  } catch (error) {
    log.api.error('Error creating IP address', {
      error: error.message,
      stack: error.stack,
      interface: iface,
      type,
      addrobj,
    });
    return res.status(500).json({
      error: 'Failed to create IP address task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/addresses/{addrobj}:
 *   delete:
 *     summary: Delete IP address
 *     description: Deletes an IP address assignment using ipadm delete-addr
 *     tags: [Network Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: addrobj
 *         required: true
 *         schema:
 *           type: string
 *         description: Address object name to delete (e.g., vnic0/v4static)
 *       - in: query
 *         name: release
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Release DHCP lease before deletion
 *     responses:
 *       202:
 *         description: IP address deletion task created successfully
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
 *                 addrobj:
 *                   type: string
 *                 release:
 *                   type: boolean
 *                   description: Whether the DHCP lease was released before deletion (echoed from the request)
 *       404:
 *         description: Address object not found
 *       500:
 *         description: Failed to create IP address deletion task
 */
export const deleteIPAddress = async (req, res) => {
  const addrobj = Array.isArray(req.params.splat)
    ? req.params.splat.join('/')
    : req.params.splat || '';
  const { release = false } = req.query;

  try {
    const result = await executeCommand(`pfexec ipadm show-addr ${addrobj}`);

    if (!result.success) {
      return res.status(404).json({
        error: `Address object ${addrobj} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'delete_ip_address',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            addrobj,
            release: release === 'true' || release === true,
          },
          (err, jsonResult) => {
            if (err) {
              reject(err);
            } else {
              resolve(jsonResult);
            }
          }
        );
      }),
    });

    log.app.info('IP address deletion task created', {
      task_id: task.id,
      addrobj,
      release: release === 'true' || release === true,
      created_by: req.entity.name,
    });

    return res.status(202).json({
      success: true,
      message: `IP address deletion task created for ${addrobj}`,
      task_id: task.id,
      addrobj,
      release: release === 'true' || release === true,
    });
  } catch (error) {
    log.api.error('Error deleting IP address', {
      error: error.message,
      stack: error.stack,
      addrobj,
    });
    return res.status(500).json({
      error: 'Failed to create IP address deletion task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/addresses/{addrobj}/enable:
 *   put:
 *     summary: Enable IP address
 *     description: Enables a disabled IP address using ipadm enable-addr
 *     tags: [Network Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: addrobj
 *         required: true
 *         schema:
 *           type: string
 *         description: Address object name to enable
 *     responses:
 *       202:
 *         description: IP address enable task created successfully
 *       404:
 *         description: Address object not found
 *       500:
 *         description: Failed to create enable task
 */
export const enableIPAddress = async (req, res) => {
  const addrobj = Array.isArray(req.params.splat)
    ? req.params.splat.join('/')
    : req.params.splat || '';
  try {
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'enable_ip_address',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            addrobj,
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
      message: `IP address enable task created for ${addrobj}`,
      task_id: task.id,
      addrobj,
    });
  } catch (error) {
    log.api.error('Error enabling IP address', {
      error: error.message,
      stack: error.stack,
      addrobj,
    });
    return res.status(500).json({
      error: 'Failed to create IP address enable task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/addresses/{addrobj}/disable:
 *   put:
 *     summary: Disable IP address
 *     description: Disables an IP address using ipadm disable-addr
 *     tags: [Network Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: addrobj
 *         required: true
 *         schema:
 *           type: string
 *         description: Address object name to disable
 *     responses:
 *       202:
 *         description: IP address disable task created successfully
 *       500:
 *         description: Failed to create disable task
 */
export const disableIPAddress = async (req, res) => {
  const addrobj = Array.isArray(req.params.splat)
    ? req.params.splat.join('/')
    : req.params.splat || '';
  try {
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'disable_ip_address',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            addrobj,
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
      message: `IP address disable task created for ${addrobj}`,
      task_id: task.id,
      addrobj,
    });
  } catch (error) {
    log.api.error('Error disabling IP address', {
      error: error.message,
      stack: error.stack,
      addrobj,
    });
    return res.status(500).json({
      error: 'Failed to create IP address disable task',
      details: error.message,
    });
  }
};
