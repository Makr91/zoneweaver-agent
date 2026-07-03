/**
 * @fileoverview System Host Shutdown Controller
 * @description Handles system shutdown operations through TaskQueue
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
 * /system/host/shutdown:
 *   post:
 *     summary: Gracefully shutdown the host system
 *     description: |
 *       Creates a task to gracefully shutdown the host system to single-user mode.
 *       **WARNING**: This will shut down all services and terminate user sessions.
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
 *                 description: Grace period in seconds before shutdown (0-7200)
 *                 default: 60
 *                 example: 300
 *               message:
 *                 type: string
 *                 description: Custom warning message for users (max 200 chars)
 *                 example: "System maintenance shutdown - services will be unavailable"
 *               confirm:
 *                 type: boolean
 *                 description: Confirmation that shutdown is intended
 *                 default: false
 *               zone_orchestration:
 *                 type: object
 *                 description: Zone orchestration configuration
 *                 properties:
 *                   enabled:
 *                     type: boolean
 *                     description: Enable zone orchestration before host shutdown
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
 *         description: Shutdown task created successfully
 *       400:
 *         description: Invalid request parameters or missing confirmation
 *       500:
 *         description: Failed to create shutdown task
 */
export const shutdownHost = async (req, res) => {
  try {
    const { grace_period, message, confirm = false, zone_orchestration } = req.body;

    // Require explicit confirmation for destructive operation
    if (!confirm) {
      return errorResponse(
        res,
        400,
        'Confirmation required',
        'You must set "confirm": true to proceed with host shutdown'
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
    const safetyCheck = checkOperationSafety('shutdown', {
      gracePeriod: gracePeriodValidation.normalizedValue,
    });

    // Create shutdown task with zone orchestration
    const task = await createSystemTask(
      'system_host_shutdown',
      {
        grace_period: gracePeriodValidation.normalizedValue,
        message: messageValidation.normalizedValue,
        method: 'graceful_shutdown',
        command: 'shutdown',
        target_state: 's', // Single-user mode
        zone_orchestration: zone_orchestration?.enabled ? zone_orchestration : null,
      },
      req.entity.name
    );

    log.monitoring.warn('Host shutdown task created', {
      task_id: task.id,
      grace_period: gracePeriodValidation.normalizedValue,
      created_by: req.entity.name,
      custom_message: messageValidation.normalizedValue,
    });

    return taskCreatedResponse(
      res,
      `Host shutdown scheduled in ${gracePeriodValidation.normalizedValue} seconds`,
      task,
      {
        warnings: safetyCheck.warnings,
        grace_period: gracePeriodValidation.normalizedValue,
        target_state: 'single-user',
      }
    );
  } catch (error) {
    log.api.error('Error creating host shutdown task', {
      error: error.message,
      stack: error.stack,
      created_by: req.entity?.name,
    });
    return errorResponse(res, 500, 'Failed to create shutdown task', error.message);
  }
};

/**
 * @swagger
 * /system/host/poweroff:
 *   post:
 *     summary: Power off the host system
 *     description: |
 *       Creates a task to power off the host system completely.
 *       **WARNING**: This will power off the entire system - manual intervention required to restart.
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
 *                 description: Grace period in seconds before poweroff (0-7200)
 *                 default: 60
 *                 example: 300
 *               message:
 *                 type: string
 *                 description: Custom warning message for users (max 200 chars)
 *                 example: "System maintenance - complete shutdown scheduled"
 *               confirm:
 *                 type: boolean
 *                 description: Confirmation that poweroff is intended
 *                 default: false
 *     responses:
 *       202:
 *         description: Poweroff task created successfully
 *       400:
 *         description: Invalid request parameters or missing confirmation
 *       500:
 *         description: Failed to create poweroff task
 */
export const poweroffHost = async (req, res) => {
  try {
    const { grace_period, message, confirm = false } = req.body;

    // Require explicit confirmation for destructive operation
    if (!confirm) {
      return errorResponse(
        res,
        400,
        'Confirmation required',
        'You must set "confirm": true to proceed with host poweroff'
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

    // Safety check
    const safetyCheck = checkOperationSafety('poweroff', {
      gracePeriod: gracePeriodValidation.normalizedValue,
    });

    // Create poweroff task
    const task = await createSystemTask(
      'system_host_poweroff',
      {
        grace_period: gracePeriodValidation.normalizedValue,
        message: messageValidation.normalizedValue,
        method: 'graceful_shutdown',
        command: 'shutdown',
        target_state: '5', // Power off
      },
      req.entity.name
    );

    log.monitoring.warn('Host poweroff task created', {
      task_id: task.id,
      grace_period: gracePeriodValidation.normalizedValue,
      created_by: req.entity.name,
      custom_message: messageValidation.normalizedValue,
    });

    return taskCreatedResponse(
      res,
      `Host poweroff scheduled in ${gracePeriodValidation.normalizedValue} seconds`,
      task,
      {
        warnings: safetyCheck.warnings,
        grace_period: gracePeriodValidation.normalizedValue,
        target_state: 'poweroff',
        note: 'System will require manual power-on to restart',
      }
    );
  } catch (error) {
    log.api.error('Error creating host poweroff task', {
      error: error.message,
      stack: error.stack,
      created_by: req.entity?.name,
    });
    return errorResponse(res, 500, 'Failed to create poweroff task', error.message);
  }
};

/**
 * @swagger
 * /system/host/halt:
 *   post:
 *     summary: Immediately halt the host system
 *     description: |
 *       Creates a task to immediately halt the host system without graceful shutdown.
 *       **WARNING**: This is an emergency operation - no grace period, immediate halt.
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
 *                 description: Confirmation that immediate halt is intended
 *                 default: false
 *               emergency:
 *                 type: boolean
 *                 description: Acknowledge this is an emergency operation
 *                 default: false
 *     responses:
 *       202:
 *         description: Halt task created successfully
 *       400:
 *         description: Invalid request parameters or missing confirmation
 *       500:
 *         description: Failed to create halt task
 */
export const haltHost = async (req, res) => {
  try {
    const { confirm = false, emergency = false } = req.body;

    // Require explicit confirmation for destructive operation
    if (!confirm) {
      return errorResponse(
        res,
        400,
        'Confirmation required',
        'You must set "confirm": true to proceed with host halt'
      );
    }

    if (!emergency) {
      return errorResponse(
        res,
        400,
        'Emergency acknowledgment required',
        'You must set "emergency": true - halt is for emergency use only'
      );
    }

    // Safety check
    const safetyCheck = checkOperationSafety('halt', { force: true, emergency: true });

    // Create halt task
    const task = await createSystemTask(
      'system_host_halt',
      {
        method: 'immediate_halt',
        command: 'halt',
        emergency: true,
      },
      req.entity.name
    );

    log.monitoring.error('EMERGENCY: Host halt task created', {
      task_id: task.id,
      created_by: req.entity.name,
      emergency: true,
    });

    return taskCreatedResponse(
      res,
      'EMERGENCY: Host halt task created - system will halt immediately',
      task,
      {
        warnings: safetyCheck.warnings,
        emergency: true,
        note: 'System will require manual intervention to restart',
      }
    );
  } catch (error) {
    log.api.error('Error creating host halt task', {
      error: error.message,
      stack: error.stack,
      created_by: req.entity?.name,
    });
    return errorResponse(res, 500, 'Failed to create halt task', error.message);
  }
};
