/**
 * @fileoverview System Host Restart Controller
 * @description Handles system restart operations through TaskQueue
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { createSystemTask, taskCreatedResponse, errorResponse } from './utils/ResponseHelpers.js';
import {
  validateGracePeriod,
  validateWarningMessage,
  checkOperationSafety,
} from './utils/SystemValidation.js';
import {
  validateOrchestrationStrategy,
  validateOrchestrationTimeouts,
} from '../../lib/ZoneOrchestrationUtils.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/host/restart:
 *   post:
 *     summary: Gracefully restart the host system
 *     description: |
 *       Creates a task to gracefully restart the host system using OmniOS shutdown command.
 *       **WARNING**: This will restart the entire host system, interrupting all services and user sessions.
 *     tags: [System Host Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               grace_period:
 *                 type: integer
 *                 description: Grace period in seconds before restart (0-7200)
 *                 default: 60
 *                 example: 300
 *               message:
 *                 type: string
 *                 description: Custom warning message for users (max 200 chars)
 *                 example: "System maintenance restart - planned downtime"
 *               confirm:
 *                 type: boolean
 *                 description: Confirmation that restart is intended
 *                 default: false
 *               zone_orchestration:
 *                 type: object
 *                 description: Zone orchestration configuration
 *                 properties:
 *                   enabled:
 *                     type: boolean
 *                     description: Enable zone orchestration before host restart
 *                     default: false
 *                   strategy:
 *                     type: string
 *                     enum: [sequential, parallel_by_priority, staggered]
 *                     description: Zone shutdown strategy
 *                     default: parallel_by_priority
 *                   failure_action:
 *                     type: string
 *                     enum: [abort, force_stuck, skip_stuck]
 *                     description: Action to take if zones fail to stop
 *                     default: abort
 *                   priority_delay:
 *                     type: integer
 *                     description: Delay in seconds between priority groups
 *                     default: 30
 *                   zone_timeout:
 *                     type: integer
 *                     description: Timeout in seconds per zone shutdown
 *                     default: 120
 *     responses:
 *       202:
 *         description: Restart task created successfully
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
 *                   format: uuid
 *                 warnings:
 *                   type: array
 *                   items:
 *                     type: string
 *       400:
 *         description: Invalid request parameters or missing confirmation
 *       500:
 *         description: Failed to create restart task
 */
export const restartHost = async (req, res) => {
  try {
    const { grace_period, message, confirm = false, zone_orchestration } = req.body;

    // Require explicit confirmation for destructive operation
    if (!confirm) {
      return errorResponse(
        res,
        400,
        'Confirmation required',
        'You must set "confirm": true to proceed with host restart'
      );
    }

    // Validate parameters
    const gracePeriodValidation = validateGracePeriod(grace_period);
    if (!gracePeriodValidation.valid) {
      return errorResponse(res, 400, gracePeriodValidation.error);
    }

    const messageValidation = validateWarningMessage(message);
    if (!messageValidation.valid) {
      return errorResponse(res, 400, messageValidation.error);
    }

    // Validate zone orchestration if provided
    if (zone_orchestration?.enabled) {
      const strategyValidation = validateOrchestrationStrategy(zone_orchestration.strategy);
      if (!strategyValidation.valid) {
        return errorResponse(res, 400, strategyValidation.error);
      }

      const timeoutValidation = validateOrchestrationTimeouts(zone_orchestration);
      if (!timeoutValidation.valid) {
        return errorResponse(res, 400, timeoutValidation.error);
      }
    }

    // Safety check
    const safetyCheck = checkOperationSafety('restart', {
      gracePeriod: gracePeriodValidation.normalizedValue,
      force: false,
    });

    // Create restart task with zone orchestration
    const task = await createSystemTask(
      'system_host_restart',
      {
        grace_period: gracePeriodValidation.normalizedValue,
        message: messageValidation.normalizedValue,
        method: 'graceful_shutdown',
        command: 'shutdown',
        zone_orchestration: zone_orchestration?.enabled ? zone_orchestration : null,
      },
      req.entity.name
    );

    log.monitoring.warn('Host restart task created', {
      task_id: task.id,
      grace_period: gracePeriodValidation.normalizedValue,
      created_by: req.entity.name,
      custom_message: messageValidation.normalizedValue,
    });

    return taskCreatedResponse(
      res,
      `Host restart scheduled in ${gracePeriodValidation.normalizedValue} seconds`,
      task,
      {
        warnings: safetyCheck.warnings,
        grace_period: gracePeriodValidation.normalizedValue,
      }
    );
  } catch (error) {
    log.api.error('Error creating host restart task', {
      error: error.message,
      stack: error.stack,
      created_by: req.entity?.name,
    });
    return errorResponse(res, 500, 'Failed to create restart task', error.message);
  }
};

/**
 * @swagger
 * /system/host/reboot:
 *   post:
 *     summary: Direct reboot of the host system
 *     description: |
 *       Creates a task to directly reboot the host system using OmniOS reboot command.
 *       **WARNING**: This is less graceful than shutdown restart - use /restart for normal operations.
 *     tags: [System Host Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               confirm:
 *                 type: boolean
 *                 description: Confirmation that reboot is intended
 *                 default: false
 *               dump_core:
 *                 type: boolean
 *                 description: Force system crash dump before reboot (for debugging)
 *                 default: false
 *     responses:
 *       202:
 *         description: Reboot task created successfully
 *       400:
 *         description: Invalid request parameters or missing confirmation
 *       500:
 *         description: Failed to create reboot task
 */
export const rebootHost = async (req, res) => {
  try {
    const { confirm = false, dump_core = false } = req.body;

    // Require explicit confirmation for destructive operation
    if (!confirm) {
      return errorResponse(
        res,
        400,
        'Confirmation required',
        'You must set "confirm": true to proceed with host reboot'
      );
    }

    // Safety check
    const safetyCheck = checkOperationSafety('reboot', { force: true });

    // Create reboot task
    const task = await createSystemTask(
      'system_host_reboot',
      {
        method: 'direct_reboot',
        command: 'reboot',
        dump_core,
      },
      req.entity.name
    );

    log.monitoring.warn('Host reboot task created', {
      task_id: task.id,
      created_by: req.entity.name,
      dump_core,
    });

    return taskCreatedResponse(
      res,
      'Host reboot task created - system will reboot immediately',
      task,
      {
        warnings: safetyCheck.warnings,
        dump_core,
      }
    );
  } catch (error) {
    log.api.error('Error creating host reboot task', {
      error: error.message,
      stack: error.stack,
      created_by: req.entity?.name,
    });
    return errorResponse(res, 500, 'Failed to create reboot task', error.message);
  }
};

/**
 * @swagger
 * /system/host/reboot/fast:
 *   post:
 *     summary: Fast reboot of the host system (x86 only)
 *     description: |
 *       Creates a task to perform fast reboot bypassing firmware (x86 systems only).
 *       **WARNING**: Fast reboot bypasses firmware initialization and boot loader.
 *     tags: [System Host Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               confirm:
 *                 type: boolean
 *                 description: Confirmation that fast reboot is intended
 *                 default: false
 *               boot_environment:
 *                 type: string
 *                 description: Specific boot environment to boot into (optional)
 *     responses:
 *       202:
 *         description: Fast reboot task created successfully
 *       400:
 *         description: Invalid request parameters or missing confirmation
 *       500:
 *         description: Failed to create fast reboot task
 */
export const fastRebootHost = async (req, res) => {
  try {
    const { confirm = false, boot_environment } = req.body;

    // Require explicit confirmation for destructive operation
    if (!confirm) {
      return errorResponse(
        res,
        400,
        'Confirmation required',
        'You must set "confirm": true to proceed with fast reboot'
      );
    }

    // Safety check
    const safetyCheck = checkOperationSafety('reboot', { force: true, fast: true });

    // Create fast reboot task
    const task = await createSystemTask(
      'system_host_reboot_fast',
      {
        method: 'fast_reboot',
        command: 'reboot',
        fast: true,
        boot_environment,
      },
      req.entity.name
    );

    log.monitoring.warn('Host fast reboot task created', {
      task_id: task.id,
      created_by: req.entity.name,
      boot_environment,
    });

    return taskCreatedResponse(
      res,
      'Host fast reboot task created - system will fast reboot immediately',
      task,
      {
        warnings: safetyCheck.warnings,
        boot_environment,
        note: 'Fast reboot only available on x86 systems',
      }
    );
  } catch (error) {
    log.api.error('Error creating host fast reboot task', {
      error: error.message,
      stack: error.stack,
      created_by: req.entity?.name,
    });
    return errorResponse(res, 500, 'Failed to create fast reboot task', error.message);
  }
};
