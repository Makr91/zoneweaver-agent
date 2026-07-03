/**
 * @fileoverview Time Sync Status Controller
 * @description Handles time sync status and system detection using ServiceManager
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { executeCommand } from '../../lib/CommandManager.js';
import {
  directSuccessResponse,
  errorResponse,
} from '../SystemHostController/utils/ResponseHelpers.js';
import { detectTimeService, detectAvailableTimeSyncSystems } from './utils/TimeServiceDetection.js';
import { parseNtpPeers, parseChronySources } from './utils/NtpParsers.js';
import { getCurrentTimezone } from './utils/TimezoneHelpers.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/time-sync/status:
 *   get:
 *     summary: Get time synchronization status
 *     description: Returns current time sync service status, peer information, and sync status
 *     tags: [Time Synchronization]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Time sync status retrieved successfully
 *       500:
 *         description: Failed to get time sync status
 */
export const getTimeSyncStatus = async (req, res) => {
  void req;
  try {
    // Detect available service using ServiceManager utilities
    const serviceInfo = await detectTimeService();

    let peers = [];

    if (serviceInfo.available && serviceInfo.details?.state === 'online') {
      if (serviceInfo.service === 'ntp') {
        // Get NTP peer information
        const ntpqResult = await executeCommand('ntpq -p');
        if (ntpqResult.success) {
          peers = parseNtpPeers(ntpqResult.output);
        }
      } else if (serviceInfo.service === 'chrony') {
        // Get Chrony source information
        const chronycResult = await executeCommand('chronyc sources');
        if (chronycResult.success) {
          peers = parseChronySources(chronycResult.output);
        }
      }
    }

    // Get current timezone
    const timezoneResult = getCurrentTimezone();

    return directSuccessResponse(res, 'Time sync status retrieved successfully', {
      service: serviceInfo.service,
      status: serviceInfo.status,
      available: serviceInfo.available,
      service_details: serviceInfo.details,
      peers,
      peer_count: peers.length,
      synchronized_peers: peers.filter(
        p => p.status === 'selected_primary' || p.status === 'selected_backup'
      ).length,
      timezone: timezoneResult.success ? timezoneResult.timezone : null,
      last_checked: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error getting time sync status', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to get time sync status', error.message);
  }
};

/**
 * @swagger
 * /system/time-sync/available-systems:
 *   get:
 *     summary: Get available time sync systems
 *     description: Returns information about available time sync systems and their installation status
 *     tags: [Time Synchronization]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Available systems retrieved successfully
 *       500:
 *         description: Failed to get available systems
 */
export const getAvailableTimeSyncSystems = async (req, res) => {
  void req;
  try {
    const systemsInfo = await detectAvailableTimeSyncSystems();

    return directSuccessResponse(
      res,
      'Available time sync systems retrieved successfully',
      systemsInfo
    );
  } catch (error) {
    log.api.error('Error getting available time sync systems', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to get available time sync systems', error.message);
  }
};
