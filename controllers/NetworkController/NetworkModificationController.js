/**
 * @fileoverview Network modification operations
 */

import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import yj from 'yieldable-json';
import { setRebootRequired } from '../../lib/RebootManager.js';
import { log } from '../../lib/Logger.js';
import { executeCommand } from '../../lib/CommandManager.js';

/**
 * @swagger
 * /network/hostname:
 *   put:
 *     summary: Set system hostname
 *     description: Sets the system hostname by updating /etc/nodename and optionally applying immediately
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
 *               - hostname
 *             properties:
 *               hostname:
 *                 type: string
 *                 description: New hostname to set
 *                 example: "new-hostname"
 *               apply_immediately:
 *                 type: boolean
 *                 description: Whether to apply hostname change immediately (requires reboot for permanent effect)
 *                 default: false
 *     responses:
 *       202:
 *         description: Hostname change task created successfully
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
 *                 hostname:
 *                   type: string
 *                 apply_immediately:
 *                   type: boolean
 *                   description: Whether hostname is applied immediately
 *                 requires_reboot:
 *                   type: boolean
 *                   description: Whether a reboot is required for full effect
 *                   example: true
 *                 reboot_reason:
 *                   type: string
 *                   description: Explanation of why reboot is needed
 *                   example: "Hostname written to /etc/nodename - reboot required to take effect"
 *                 note:
 *                   type: string
 *                   description: Additional information about the hostname change
 *       400:
 *         description: Invalid hostname
 *       500:
 *         description: Failed to create hostname change task
 */
export const setHostname = async (req, res) => {
  const { hostname, apply_immediately = false } = req.body;

  try {
    if (!hostname || typeof hostname !== 'string') {
      return res.status(400).json({
        error: 'hostname is required and must be a string',
      });
    }

    // Validate hostname format (allows both simple hostnames and FQDNs)
    const hostnameRegex = /^[a-zA-Z0-9](?:[a-zA-Z0-9-.]{0,251}[a-zA-Z0-9])?$/;
    if (!hostnameRegex.test(hostname)) {
      return res.status(400).json({
        error:
          'Invalid hostname format. Must be alphanumeric with hyphens and dots, 1-253 characters',
      });
    }

    // Additional validation: each label (part between dots) must be ≤63 characters
    const labels = hostname.split('.');
    for (const label of labels) {
      if (label.length === 0 || label.length > 63) {
        return res.status(400).json({
          error: 'Invalid hostname format. Each part between dots must be 1-63 characters',
        });
      }
      if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)) {
        return res.status(400).json({
          error:
            'Invalid hostname format. Each part must start and end with alphanumeric characters',
        });
      }
    }

    // Create task for hostname change
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'set_hostname',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            hostname,
            apply_immediately,
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

    // Set reboot required flag for hostname changes
    await setRebootRequired('hostname_change', 'NetworkController');

    return res.status(202).json({
      success: true,
      message: `Hostname change task created for: ${hostname}`,
      task_id: task.id,
      hostname,
      apply_immediately,
      requires_reboot: true,
      reboot_reason: apply_immediately
        ? 'Hostname applied immediately but reboot required for full persistence'
        : 'Hostname written to /etc/nodename - reboot required to take effect',
      note: apply_immediately
        ? 'Hostname will be applied immediately but reboot required for persistence'
        : 'Hostname will be set in /etc/nodename only',
    });
  } catch (error) {
    log.api.error('Error setting hostname', {
      error: error.message,
      stack: error.stack,
      hostname,
    });
    return res.status(500).json({
      error: 'Failed to create hostname change task',
      details: error.message,
    });
  }
};

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
    // Validate required fields
    if (!iface || !type || !addrobj) {
      return res.status(400).json({
        error: 'interface, type, and addrobj are required',
      });
    }

    // Validate type-specific requirements
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

    // Create task for IP address creation
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
  // With wildcard route (*splat), the addrobj is in req.params.splat
  const addrobj = Array.isArray(req.params.splat)
    ? req.params.splat.join('/')
    : req.params.splat || ''; // Express 5.x compatibility fix
  const { release = false } = req.query;

  try {
    // Check if address object exists in current system
    const result = await executeCommand(`pfexec ipadm show-addr ${addrobj}`);

    if (!result.success) {
      return res.status(404).json({
        error: `Address object ${addrobj} not found`,
        details: result.error,
      });
    }

    // Create task for IP address deletion
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
  // With wildcard route (*splat), the addrobj is in req.params.splat
  const addrobj = Array.isArray(req.params.splat)
    ? req.params.splat.join('/')
    : req.params.splat || ''; // Express 5.x compatibility fix
  try {
    // Create task for enabling IP address
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
  // With wildcard route (*splat), the addrobj is in req.params.splat
  const addrobj = Array.isArray(req.params.splat)
    ? req.params.splat.join('/')
    : req.params.splat || ''; // Express 5.x compatibility fix
  try {
    // Create task for disabling IP address
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
