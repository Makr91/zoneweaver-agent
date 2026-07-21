/**
 * @fileoverview Network modification operations
 */

import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { stringifyAsync } from '../../lib/AsyncJson.js';
import { setRebootRequired } from '../../lib/RebootManager.js';
import { log } from '../../lib/Logger.js';

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

    const hostnameRegex = /^[a-zA-Z0-9](?:[a-zA-Z0-9-.]{0,251}[a-zA-Z0-9])?$/;
    if (!hostnameRegex.test(hostname)) {
      return res.status(400).json({
        error:
          'Invalid hostname format. Must be alphanumeric with hyphens and dots, 1-253 characters',
      });
    }

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

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'set_hostname',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await stringifyAsync({
        hostname,
        apply_immediately,
      }),
    });

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
