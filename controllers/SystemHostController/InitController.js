/**
 * @fileoverview System Host Init Controller
 * @description Handles system runlevel changes through TaskQueue
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { executeCommand } from '../../lib/CommandManager.js';
import {
  createSystemTask,
  taskCreatedResponse,
  directSuccessResponse,
  errorResponse,
} from './utils/ResponseHelpers.js';
import {
  validateRunlevel,
  checkOperationSafety,
  RUNLEVEL_DESCRIPTIONS,
} from './utils/SystemValidation.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/host/runlevel:
 *   get:
 *     summary: Get current system runlevel
 *     description: Returns the current init runlevel and description
 *     tags: [System Host Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Current runlevel retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 current_runlevel:
 *                   type: string
 *                   description: Current system runlevel
 *                 description:
 *                   type: string
 *                   description: Description of current runlevel
 *                 available_runlevels:
 *                   type: object
 *                   additionalProperties:
 *                     type: string
 *       500:
 *         description: Failed to retrieve runlevel information
 */
export const getCurrentRunlevel = async (req, res) => {
  void req;
  try {
    let currentRunlevel = 'unknown';
    let description = 'Unknown';

    try {
      const whoResult = await executeCommand('who -r');
      if (whoResult.success) {
        const match = whoResult.output.match(/run-level (?<level>\w)/);
        if (match) {
          currentRunlevel = match.groups.level;
          description = RUNLEVEL_DESCRIPTIONS[currentRunlevel] || 'Unknown';
        }
      }
    } catch (error) {
      log.monitoring.warn('Failed to get current runlevel', {
        error: error.message,
      });
    }

    return directSuccessResponse(res, 'Current runlevel retrieved successfully', {
      current_runlevel: currentRunlevel,
      description,
      available_runlevels: RUNLEVEL_DESCRIPTIONS,
    });
  } catch (error) {
    log.api.error('Error getting current runlevel', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to retrieve runlevel information', error.message);
  }
};

/**
 * @swagger
 * /system/host/runlevel:
 *   post:
 *     summary: Change system runlevel
 *     description: |
 *       Creates a task to change the system runlevel using init command.
 *       **WARNING**: Changing runlevels can affect system services and user sessions.
 *     tags: [System Host Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - runlevel
 *             properties:
 *               runlevel:
 *                 type: string
 *                 description: Target runlevel (0-6, s, S)
 *                 example: "3"
 *               confirm:
 *                 type: boolean
 *                 description: Confirmation that runlevel change is intended
 *                 default: false
 *     responses:
 *       202:
 *         description: Runlevel change task created successfully
 *       400:
 *         description: Invalid runlevel or missing confirmation
 *       500:
 *         description: Failed to create runlevel change task
 */
export const changeRunlevel = async (req, res) => {
  try {
    const { runlevel, confirm = false } = req.body;

    if (!confirm) {
      return errorResponse(
        res,
        400,
        'Confirmation required',
        'You must set "confirm": true to proceed with runlevel change'
      );
    }

    const runlevelValidation = validateRunlevel(runlevel);
    if (!runlevelValidation.valid) {
      return errorResponse(res, 400, runlevelValidation.error);
    }

    const targetLevel = runlevelValidation.normalizedValue;
    const targetDescription = RUNLEVEL_DESCRIPTIONS[targetLevel] || 'Unknown';

    const safetyCheck = checkOperationSafety('runlevel_change', {
      targetLevel,
    });

    const task = await createSystemTask(
      'system_host_runlevel_change',
      {
        target_runlevel: targetLevel,
        method: 'init_command',
        command: 'init',
      },
      req.entity.name
    );

    log.monitoring.warn('Host runlevel change task created', {
      task_id: task.id,
      target_runlevel: targetLevel,
      target_description: targetDescription,
      created_by: req.entity.name,
    });

    return taskCreatedResponse(
      res,
      `Runlevel change to ${targetLevel} (${targetDescription}) task created`,
      task,
      {
        warnings: safetyCheck.warnings,
        target_runlevel: targetLevel,
        target_description: targetDescription,
      }
    );
  } catch (error) {
    log.api.error('Error creating runlevel change task', {
      error: error.message,
      stack: error.stack,
      created_by: req.entity?.name,
    });
    return errorResponse(res, 500, 'Failed to create runlevel change task', error.message);
  }
};

/**
 * @swagger
 * /system/host/single-user:
 *   post:
 *     summary: Enter single-user mode
 *     description: |
 *       Creates a task to transition system to single-user mode (runlevel s).
 *       **WARNING**: This will terminate user sessions and most services.
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
 *                 description: Confirmation that single-user mode is intended
 *                 default: false
 *     responses:
 *       202:
 *         description: Single-user mode task created successfully
 *       400:
 *         description: Missing confirmation
 *       500:
 *         description: Failed to create single-user mode task
 */
export const enterSingleUserMode = async (req, res) => {
  try {
    const { confirm = false } = req.body;

    if (!confirm) {
      return errorResponse(
        res,
        400,
        'Confirmation required',
        'You must set "confirm": true to proceed with single-user mode'
      );
    }

    const safetyCheck = checkOperationSafety('runlevel_change', {
      targetLevel: 's',
    });

    const task = await createSystemTask(
      'system_host_runlevel_change',
      {
        target_runlevel: 's',
        method: 'init_command',
        command: 'init',
      },
      req.entity.name
    );

    log.monitoring.warn('Single-user mode task created', {
      task_id: task.id,
      created_by: req.entity.name,
    });

    return taskCreatedResponse(
      res,
      'Single-user mode task created - system will enter administrative mode',
      task,
      {
        warnings: safetyCheck.warnings,
        target_runlevel: 's',
        target_description: 'Single-user administrative mode',
      }
    );
  } catch (error) {
    log.api.error('Error creating single-user mode task', {
      error: error.message,
      stack: error.stack,
      created_by: req.entity?.name,
    });
    return errorResponse(res, 500, 'Failed to create single-user mode task', error.message);
  }
};

/**
 * @swagger
 * /system/host/multi-user:
 *   post:
 *     summary: Enter multi-user mode
 *     description: |
 *       Creates a task to transition system to multi-user mode (runlevel 2).
 *       This will start normal multi-user services and allow user logins.
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
 *               network_services:
 *                 type: boolean
 *                 description: Also enable network services (runlevel 3)
 *                 default: false
 *     responses:
 *       202:
 *         description: Multi-user mode task created successfully
 *       500:
 *         description: Failed to create multi-user mode task
 */
export const enterMultiUserMode = async (req, res) => {
  try {
    const { network_services = false } = req.body;
    const targetLevel = network_services ? '3' : '2';
    const description = network_services
      ? 'Multi-user mode with network services'
      : 'Multi-user mode';

    const task = await createSystemTask(
      'system_host_runlevel_change',
      {
        target_runlevel: targetLevel,
        method: 'init_command',
        command: 'init',
      },
      req.entity.name
    );

    log.monitoring.info('Multi-user mode task created', {
      task_id: task.id,
      target_runlevel: targetLevel,
      network_services,
      created_by: req.entity.name,
    });

    return taskCreatedResponse(
      res,
      `${description} task created - system will enter multi-user operation`,
      task,
      {
        target_runlevel: targetLevel,
        target_description: description,
        network_services,
      }
    );
  } catch (error) {
    log.api.error('Error creating multi-user mode task', {
      error: error.message,
      stack: error.stack,
      created_by: req.entity?.name,
    });
    return errorResponse(res, 500, 'Failed to create multi-user mode task', error.message);
  }
};
