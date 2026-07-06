/**
 * @fileoverview VNC Management Controller
 * @description Handles VNC session listing and management operations
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import VncSessions from '../../models/VncSessionModel.js';
import { errorResponse } from '../SystemHostController/utils/ResponseHelpers.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /vnc/sessions:
 *   get:
 *     summary: List all VNC sessions
 *     description: Retrieves a list of all VNC sessions with optional filtering
 *     tags: [VNC Console]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: VNC sessions retrieved successfully
 */
export const listVncSessions = async (req, res) => {
  try {
    // Prevent caching for real-time VNC session data
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });

    const { status, machine_name } = req.query;
    const whereClause = {};

    if (status) {
      whereClause.status = status;
    }
    if (machine_name) {
      whereClause.zone_name = machine_name;
    }

    const sessions = await VncSessions.findAll({
      where: whereClause,
      order: [['created_at', 'DESC']],
    });

    const activeCount = await VncSessions.count({
      where: { status: 'active' },
    });

    return res.json({
      sessions,
      total: sessions.length,
      active_count: activeCount,
    });
  } catch (error) {
    log.websocket.error('Error listing VNC sessions', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to retrieve VNC sessions', error.message);
  }
};
