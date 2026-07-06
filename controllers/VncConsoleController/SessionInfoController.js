/**
 * @fileoverview VNC Session Info Controller
 * @description Handles VNC session info retrieval (including orphaned process recovery)
 * and session stop operations
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import VncSessions from '../../models/VncSessionModel.js';
import { executeCommand } from '../../lib/CommandManager.js';
import {
  directSuccessResponse,
  errorResponse,
} from '../SystemHostController/utils/ResponseHelpers.js';
import { validateZoneName } from './utils/VncValidation.js';
import { sessionManager } from './utils/VncSessionManager.js';
import { log } from '../../lib/Logger.js';

/**
 * Handle checking for orphaned VNC processes
 */
const handleOrphanedProcessCheck = async (req, res, zoneName) => {
  // Double-check by looking for any running VNC process for this zone
  log.websocket.debug('No PID file found, checking for running VNC processes', {
    zone_name: zoneName,
  });

  // Use ProcessManager to find running VNC processes
  const runningProcesses = await executeCommand('ps auxww');
  if (!runningProcesses.success) {
    return res.status(200).json({
      active_vnc_session: false,
      vnc_session_info: null,
      machine_name: zoneName,
      message: 'No active VNC session found',
    });
  }

  // Parse for VNC processes for this zone
  const lines = runningProcesses.output.split('\n');
  const vncProcess = lines.find(
    line => line.includes('zadm vnc') && line.includes('-w 0.0.0.0:') && line.includes(zoneName)
  );

  if (vncProcess) {
    const parts = vncProcess.trim().split(/\s+/);
    const [, pid] = parts;
    const portMatch = vncProcess.match(/-w 0\.0\.0\.0:(?<port>\d+)\s/);
    const port = portMatch ? parseInt(portMatch.groups.port) : null;

    if (port) {
      log.websocket.info('Found orphaned VNC process', {
        zone_name: zoneName,
        pid: parseInt(pid),
        port,
      });

      // Create PID file for the orphaned process
      const netport = `0.0.0.0:${port}`;
      sessionManager.writeSessionInfo(zoneName, parseInt(pid), 'webvnc', netport);

      // Update database
      try {
        await VncSessions.destroy({ where: { zone_name: zoneName } });
        await VncSessions.create({
          zone_name: zoneName,
          web_port: port,
          host_ip: '127.0.0.1',
          requested_port: null,
          console_host: '0.0.0.0',
          port_source: 'dynamic',
          process_id: parseInt(pid),
          status: 'active',
          created_at: new Date(),
          last_accessed: new Date(),
        });
      } catch (dbError) {
        log.websocket.warn('Failed to update database for orphaned session', {
          error: dbError.message,
        });
      }

      // Get the actual host IP for direct VNC access
      const [hostIP] = req.get('host').split(':');

      return res.json({
        active_vnc_session: true,
        vnc_session_info: {
          machine_name: zoneName,
          web_port: port,
          host_ip: '127.0.0.1',
          process_id: parseInt(pid),
          status: 'active',
          created_at: new Date().toISOString(),
          last_accessed: new Date().toISOString(),
          console_url: `http://${hostIP}:${port}/`,
          proxy_url: `${req.protocol}://${req.get('host')}/machines/${zoneName}/vnc/console`,
          direct_access: true,
        },
      });
    }
  }

  return res.status(200).json({
    active_vnc_session: false,
    vnc_session_info: null,
    machine_name: zoneName,
    message: 'No active VNC session found',
  });
};

/**
 * @swagger
 * /machines/{machineName}/vnc/info:
 *   get:
 *     summary: Get VNC session information
 *     description: Retrieves information about the active VNC session for a machine (zone)
 *     tags: [VNC Console]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine
 *     responses:
 *       200:
 *         description: VNC session information retrieved successfully
 *       404:
 *         description: No active VNC session found
 */
export const getVncSessionInfo = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;

    // Prevent caching for real-time VNC session data
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });

    if (!validateZoneName(zoneName)) {
      return errorResponse(res, 400, 'Invalid zone name');
    }

    // Check PID file first
    const sessionInfo = sessionManager.getSessionInfo(zoneName);

    if (!sessionInfo) {
      const result = await handleOrphanedProcessCheck(req, res, zoneName);
      return result;
    }

    log.websocket.info('VNC session info retrieved', {
      zone_name: zoneName,
      pid: sessionInfo.pid,
      port: sessionInfo.port,
    });

    // Update database last_accessed time
    try {
      await VncSessions.update(
        { last_accessed: new Date() },
        { where: { zone_name: zoneName, status: 'active' } }
      );
    } catch (dbError) {
      log.websocket.warn('Failed to update database', {
        zone_name: zoneName,
        error: dbError.message,
      });
    }

    // Get the actual host IP for direct VNC access
    const [hostIP] = req.get('host').split(':');

    return res.json({
      active_vnc_session: true,
      vnc_session_info: {
        machine_name: zoneName,
        web_port: sessionInfo.port,
        host_ip: '127.0.0.1',
        process_id: sessionInfo.pid,
        status: 'active',
        created_at: sessionInfo.timestamp,
        last_accessed: new Date().toISOString(),
        console_url: `http://${hostIP}:${sessionInfo.port}/`,
        proxy_url: `${req.protocol}://${req.get('host')}/machines/${zoneName}/vnc/console`,
        direct_access: true,
      },
    });
  } catch (error) {
    log.websocket.error('Error getting VNC session info', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to retrieve VNC session information', error.message);
  }
};

/**
 * @swagger
 * /machines/{machineName}/vnc/stop:
 *   delete:
 *     summary: Stop VNC console session
 *     description: Stops the active VNC console session for a machine (zone)
 *     tags: [VNC Console]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine
 *     responses:
 *       200:
 *         description: VNC session stopped successfully
 *       404:
 *         description: No active VNC session found
 *       500:
 *         description: Failed to stop VNC session
 */
export const stopVncSession = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return errorResponse(res, 400, 'Invalid zone name');
    }

    // Use session manager to kill session
    const killed = await sessionManager.killSession(zoneName);

    if (!killed) {
      return errorResponse(res, 404, 'No active VNC session found');
    }

    // Update database
    try {
      await VncSessions.update(
        { status: 'stopped' },
        { where: { zone_name: zoneName, status: 'active' } }
      );
    } catch (dbError) {
      log.websocket.warn('Failed to update database', {
        zone_name: zoneName,
        error: dbError.message,
      });
    }

    log.websocket.info('VNC session stopped successfully', {
      zone_name: zoneName,
    });

    return directSuccessResponse(res, 'VNC session stopped successfully', {
      machine_name: zoneName,
    });
  } catch (error) {
    log.websocket.error('Error stopping VNC session', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to stop VNC session', error.message);
  }
};
