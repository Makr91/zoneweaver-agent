/**
 * @fileoverview Timezone Controller
 * @description Handles timezone operations using task queue and existing utilities
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { TaskPriority } from '../../models/TaskModel.js';
import {
  createSystemTask,
  taskCreatedResponse,
  directSuccessResponse,
  errorResponse,
} from '../SystemHostController/utils/ResponseHelpers.js';
import {
  getCurrentTimezone,
  getAvailableTimezones,
  validateTimezone,
} from './utils/TimezoneHelpers.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/timezone:
 *   get:
 *     summary: Get current timezone
 *     description: Returns the current system timezone configuration
 *     tags: [Time Synchronization]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Current timezone retrieved successfully
 *       500:
 *         description: Failed to get timezone
 */
export const getTimezone = async (req, res) => {
  void req;
  try {
    const timezoneResult = getCurrentTimezone();

    if (!timezoneResult.success) {
      return errorResponse(res, 500, 'Failed to get current timezone', timezoneResult.error);
    }

    // Get count of available timezones
    const availableTimezones = await getAvailableTimezones();

    return directSuccessResponse(res, 'Current timezone retrieved successfully', {
      timezone: timezoneResult.timezone,
      config_file: '/etc/default/init',
      available_timezones_count: availableTimezones.success
        ? availableTimezones.timezones.length
        : 0,
      last_checked: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error getting timezone', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to get timezone', error.message);
  }
};

/**
 * @swagger
 * /system/timezone:
 *   put:
 *     summary: Set system timezone
 *     description: Updates the system timezone in /etc/default/init
 *     tags: [Time Synchronization]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - timezone
 *             properties:
 *               timezone:
 *                 type: string
 *                 description: Timezone to set (e.g., America/New_York)
 *                 example: "America/New_York"
 *               backup_existing:
 *                 type: boolean
 *                 default: true
 *                 description: Create backup of existing config
 *     responses:
 *       202:
 *         description: Timezone update task created
 *       400:
 *         description: Invalid timezone or request
 */
export const setTimezone = async (req, res) => {
  try {
    const { timezone, backup_existing = true } = req.body;

    if (!timezone || typeof timezone !== 'string') {
      return errorResponse(res, 400, 'timezone is required and must be a string');
    }

    // Validate timezone exists using utility function
    if (!validateTimezone(timezone)) {
      return errorResponse(res, 400, 'Invalid timezone', {
        timezone,
        details: `Timezone file not found: /usr/share/lib/zoneinfo/${timezone}`,
      });
    }

    // Create task using ResponseHelpers and delegate to existing TimeManager
    const task = await createSystemTask(
      'set_timezone',
      {
        timezone,
        backup_existing,
      },
      req.entity.name,
      TaskPriority.HIGH
    );

    return taskCreatedResponse(res, `Timezone update task created: ${timezone}`, task, {
      timezone,
    });
  } catch (error) {
    log.api.error('Error creating timezone update task', {
      error: error.message,
      stack: error.stack,
      timezone: req.body?.timezone,
    });
    return errorResponse(res, 500, 'Failed to create timezone update task', error.message);
  }
};

/**
 * @swagger
 * /system/timezones:
 *   get:
 *     summary: List available timezones
 *     description: Returns a list of all available timezones from the system
 *     tags: [Time Synchronization]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: region
 *         schema:
 *           type: string
 *         description: Filter by region (e.g., America, Europe, Asia)
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search for timezone names containing this string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Maximum number of timezones to return (0 = all)
 *     responses:
 *       200:
 *         description: Available timezones retrieved successfully
 */
export const listTimezones = async (req, res) => {
  try {
    const { region, search, limit = 0 } = req.query;

    const availableTimezones = await getAvailableTimezones();

    if (!availableTimezones.success) {
      return errorResponse(res, 500, 'Failed to get available timezones', availableTimezones.error);
    }

    let { timezones } = availableTimezones;
    let filtered = false;

    // Apply region filter
    if (region) {
      timezones = timezones.filter(tz => tz.startsWith(`${region}/`));
      filtered = true;
    }

    // Apply search filter
    if (search) {
      const searchLower = search.toLowerCase();
      timezones = timezones.filter(tz => tz.toLowerCase().includes(searchLower));
      filtered = true;
    }

    // Apply limit (0 = no limit, return all)
    const total = timezones.length;
    const parsedLimit = parseInt(limit);
    if (parsedLimit > 0) {
      timezones = timezones.slice(0, parsedLimit);
    }

    return directSuccessResponse(res, 'Available timezones retrieved successfully', {
      timezones,
      total,
      showing: timezones.length,
      filtered,
      filters: {
        region: region || null,
        search: search || null,
        limit: parsedLimit,
      },
    });
  } catch (error) {
    log.api.error('Error listing timezones', {
      error: error.message,
      stack: error.stack,
      region: req.query.region,
      search: req.query.search,
    });
    return errorResponse(res, 500, 'Failed to list timezones', error.message);
  }
};
