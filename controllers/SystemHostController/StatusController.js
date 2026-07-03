/**
 * @fileoverview System Host Status Controller
 * @description Handles system status, uptime, and reboot flag management
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import os from 'os';
import { executeCommand } from '../../lib/CommandManager.js';
import { getRebootStatus, clearRebootRequired } from '../../lib/RebootManager.js';
import { log } from '../../lib/Logger.js';
import { directSuccessResponse, errorResponse } from './utils/ResponseHelpers.js';
import { RUNLEVEL_DESCRIPTIONS } from './utils/SystemValidation.js';

/**
 * @swagger
 * /system/host/status:
 *   get:
 *     summary: Get comprehensive system host status
 *     description: Returns detailed information about system status, uptime, and resource usage
 *     tags: [System Host Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: System status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 hostname:
 *                   type: string
 *                   description: System hostname
 *                 uptime:
 *                   type: object
 *                   properties:
 *                     seconds:
 *                       type: number
 *                     formatted:
 *                       type: string
 *                     boot_time:
 *                       type: string
 *                       format: date-time
 *                 load_average:
 *                   type: array
 *                   items:
 *                     type: number
 *                   description: 1, 5, and 15 minute load averages
 *                 memory:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: number
 *                     free:
 *                       type: number
 *                     used:
 *                       type: number
 *                 runlevel:
 *                   type: object
 *                   properties:
 *                     current:
 *                       type: string
 *                     description:
 *                       type: string
 *                 reboot_required:
 *                   type: boolean
 *                 reboot_info:
 *                   type: object
 *       500:
 *         description: Failed to retrieve system status
 */
export const getSystemStatus = async (req, res) => {
  void req;
  try {
    // Get basic system information
    const hostname = os.hostname();
    const uptimeSeconds = os.uptime();
    const loadAvg = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    // Get current runlevel
    let currentRunlevel = 'unknown';
    let runlevelDescription = 'Unknown';
    try {
      const whoResult = await executeCommand('who -r');
      if (whoResult.success) {
        const match = whoResult.output.match(/run-level (?<level>\w)/);
        if (match) {
          currentRunlevel = match.groups.level;
          runlevelDescription = RUNLEVEL_DESCRIPTIONS[currentRunlevel] || 'Unknown';
        }
      }
    } catch (error) {
      log.monitoring.warn('Failed to get current runlevel', {
        error: error.message,
      });
    }

    // Get reboot status
    const rebootStatus = await getRebootStatus();

    // Format uptime
    const bootTime = new Date(Date.now() - uptimeSeconds * 1000);

    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const secs = Math.floor(uptimeSeconds % 60);

    let formattedUptime = '';
    if (days > 0) {
      formattedUptime += `${days} day${days > 1 ? 's' : ''}, `;
    }
    if (hours > 0) {
      formattedUptime += `${hours} hour${hours > 1 ? 's' : ''}, `;
    }
    if (minutes > 0) {
      formattedUptime += `${minutes} minute${minutes > 1 ? 's' : ''}, `;
    }
    formattedUptime += `${secs} second${secs > 1 ? 's' : ''}`;

    return directSuccessResponse(res, 'System status retrieved successfully', {
      hostname,
      uptime: {
        seconds: uptimeSeconds,
        formatted: formattedUptime,
        boot_time: bootTime.toISOString(),
      },
      load_average: loadAvg,
      memory: {
        total: totalMem,
        free: freeMem,
        used: totalMem - freeMem,
        usage_percent: Math.round(((totalMem - freeMem) / totalMem) * 100),
      },
      runlevel: {
        current: currentRunlevel,
        description: runlevelDescription,
      },
      reboot_required: rebootStatus.reboot_required,
      reboot_info: rebootStatus.reboot_required
        ? {
            timestamp: rebootStatus.timestamp,
            reasons: rebootStatus.reasons,
            age_minutes: rebootStatus.age_minutes,
            created_by: rebootStatus.created_by,
          }
        : null,
    });
  } catch (error) {
    log.api.error('Error getting system status', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to retrieve system status', error.message);
  }
};

/**
 * @swagger
 * /system/host/uptime:
 *   get:
 *     summary: Get detailed system uptime information
 *     description: Returns comprehensive uptime and boot information
 *     tags: [System Host Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Uptime information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 uptime_seconds:
 *                   type: number
 *                 uptime_formatted:
 *                   type: string
 *                 boot_time:
 *                   type: string
 *                   format: date-time
 *                 load_averages:
 *                   type: object
 *                   properties:
 *                     "1min":
 *                       type: number
 *                     "5min":
 *                       type: number
 *                     "15min":
 *                       type: number
 *       500:
 *         description: Failed to retrieve uptime information
 */
export const getSystemUptime = (req, res) => {
  void req;
  try {
    const uptimeSeconds = os.uptime();
    const loadAvg = os.loadavg();
    const bootTime = new Date(Date.now() - uptimeSeconds * 1000);

    // Format uptime in multiple ways
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = Math.floor(uptimeSeconds % 60);

    const formatted = `${days}d ${hours}h ${minutes}m ${seconds}s`;

    return directSuccessResponse(res, 'Uptime information retrieved successfully', {
      uptime_seconds: uptimeSeconds,
      uptime_formatted: formatted,
      boot_time: bootTime.toISOString(),
      load_averages: {
        '1min': loadAvg[0],
        '5min': loadAvg[1],
        '15min': loadAvg[2],
      },
    });
  } catch (error) {
    log.api.error('Error getting system uptime', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to retrieve uptime information', error.message);
  }
};

/**
 * @swagger
 * /system/host/reboot-status:
 *   get:
 *     summary: Get system reboot status and pending reasons
 *     description: Returns information about whether a reboot is required and why
 *     tags: [System Host Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Reboot status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 reboot_required:
 *                   type: boolean
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 reasons:
 *                   type: array
 *                   items:
 *                     type: string
 *                 created_by:
 *                   type: string
 *                 age_minutes:
 *                   type: number
 *       500:
 *         description: Failed to retrieve reboot status
 */
export const getRebootRequiredStatus = async (req, res) => {
  void req;
  try {
    const rebootStatus = await getRebootStatus();
    return directSuccessResponse(res, 'Reboot status retrieved successfully', rebootStatus);
  } catch (error) {
    log.api.error('Error getting reboot status', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to retrieve reboot status', error.message);
  }
};

/**
 * @swagger
 * /system/host/reboot-status:
 *   delete:
 *     summary: Clear reboot required flags
 *     description: Manually clear all reboot required flags (use with caution)
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
 *               reason:
 *                 type: string
 *                 description: Reason for clearing flags
 *                 default: "manual_clear_via_api"
 *     responses:
 *       200:
 *         description: Reboot flags cleared successfully
 *       500:
 *         description: Failed to clear reboot flags
 */
export const clearRebootRequiredStatus = async (req, res) => {
  try {
    const { reason = 'manual_clear_via_api' } = req.body;

    await clearRebootRequired(reason);

    log.monitoring.info('Reboot flags manually cleared via API', {
      cleared_by: req.entity.name,
      reason,
    });

    return directSuccessResponse(res, 'Reboot required flags cleared successfully', {
      cleared_by: req.entity.name,
      reason,
    });
  } catch (error) {
    log.api.error('Error clearing reboot status', {
      error: error.message,
      stack: error.stack,
      cleared_by: req.entity.name,
    });
    return errorResponse(res, 500, 'Failed to clear reboot flags', error.message);
  }
};
