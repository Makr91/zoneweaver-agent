/**
 * @fileoverview Time Sync Operations Controller
 * @description Handles time sync operations and system switching using task queue
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { TaskPriority } from '../../models/TaskModel.js';
import {
  createSystemTask,
  taskCreatedResponse,
  errorResponse,
} from '../SystemHostController/utils/ResponseHelpers.js';
import { detectTimeService, detectAvailableTimeSyncSystems } from './utils/TimeServiceDetection.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/time-sync/sync:
 *   post:
 *     summary: Force time synchronization
 *     description: Forces an immediate time sync using ntpdig or chrony
 *     tags: [Time Synchronization]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               server:
 *                 type: string
 *                 description: Specific NTP server to sync from (optional)
 *               timeout:
 *                 type: integer
 *                 default: 30
 *                 description: Sync timeout in seconds
 *     responses:
 *       202:
 *         description: Sync task created successfully
 *       404:
 *         description: No time sync service available
 */
export const forceTimeSync = async (req, res) => {
  try {
    const { server, timeout = 30 } = req.body || {};

    // Detect available service using ServiceManager utilities
    const serviceInfo = await detectTimeService();

    if (!serviceInfo.available) {
      return errorResponse(res, 404, 'No time synchronization service available', {
        service: serviceInfo.service,
        details: serviceInfo.details,
      });
    }

    // Create task using ResponseHelpers and delegate to existing TimeManager
    const task = await createSystemTask(
      'force_time_sync',
      {
        service: serviceInfo.service,
        server,
        timeout,
      },
      req.entity.name,
      TaskPriority.HIGH
    );

    return taskCreatedResponse(
      res,
      `Time sync task created for ${serviceInfo.service}${server ? ` using server ${server}` : ''}`,
      task,
      {
        service: serviceInfo.service,
        server: server || 'auto-detect',
      }
    );
  } catch (error) {
    log.api.error('Error creating force time sync task', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to create time sync task', error.message);
  }
};

/**
 * @swagger
 * /system/time-sync/switch:
 *   post:
 *     summary: Switch time sync system
 *     description: Switches between different time synchronization systems (NTP, Chrony, NTPsec, or none)
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
 *               - target_system
 *             properties:
 *               target_system:
 *                 type: string
 *                 enum: [ntp, chrony, ntpsec, none]
 *                 description: Target time sync system to switch to
 *               preserve_servers:
 *                 type: boolean
 *                 default: true
 *                 description: Attempt to migrate server list from current config
 *               install_if_needed:
 *                 type: boolean
 *                 default: true
 *                 description: Install target package if not present
 *     responses:
 *       202:
 *         description: System switch task created
 *       400:
 *         description: Invalid request or target system
 *       409:
 *         description: Cannot switch to requested system
 */
export const switchTimeSyncSystem = async (req, res) => {
  try {
    const { target_system, preserve_servers = true, install_if_needed = true } = req.body;

    if (!target_system || !['ntp', 'chrony', 'ntpsec', 'none'].includes(target_system)) {
      return errorResponse(
        res,
        400,
        'target_system is required and must be one of: ntp, chrony, ntpsec, none'
      );
    }

    // Get current system info using ServiceManager utilities
    const systemsInfo = await detectAvailableTimeSyncSystems();
    const currentSystem = systemsInfo.current.service;

    // Check if already using target system
    if (currentSystem === target_system) {
      return errorResponse(res, 400, `Already using ${target_system}`, {
        current_system: currentSystem,
        target_system,
      });
    }

    // Check if we can switch to target system
    if (target_system !== 'none') {
      const targetInfo = systemsInfo.available[target_system];
      if (!targetInfo) {
        return errorResponse(res, 400, `Unknown target system: ${target_system}`);
      }

      if (!targetInfo.can_switch_to) {
        return errorResponse(res, 409, `Cannot switch to ${target_system}`, {
          details: 'System is not available for switching',
          target_info: targetInfo,
        });
      }

      // If package is not installed and install_if_needed is false
      if (!targetInfo.installed && !install_if_needed) {
        return errorResponse(res, 409, `Cannot switch to ${target_system}`, {
          details: `Package ${targetInfo.package_name} is not installed and install_if_needed is false`,
          requires_installation: true,
        });
      }
    }

    // Create task using ResponseHelpers and delegate to existing TimeManager
    const task = await createSystemTask(
      'switch_time_sync_system',
      {
        current_system: currentSystem,
        target_system,
        preserve_servers,
        install_if_needed,
        systems_info: systemsInfo,
      },
      req.entity.name,
      TaskPriority.HIGH
    );

    // Estimate duration based on what needs to be done
    let estimatedDuration = '30-60 seconds';
    if (target_system !== 'none') {
      const targetInfo = systemsInfo.available[target_system];
      if (!targetInfo.installed && install_if_needed) {
        estimatedDuration = '2-5 minutes';
      }
    }

    return taskCreatedResponse(
      res,
      `Time sync system switch task created: ${currentSystem} → ${target_system}`,
      task,
      {
        current_system: currentSystem,
        target_system,
        requires_installation:
          target_system !== 'none' ? !systemsInfo.available[target_system]?.installed : false,
        estimated_duration: estimatedDuration,
      }
    );
  } catch (error) {
    log.api.error('Error creating time sync system switch task', {
      error: error.message,
      stack: error.stack,
      target_system: req.body?.target_system,
    });
    return errorResponse(res, 500, 'Failed to create time sync system switch task', error.message);
  }
};
