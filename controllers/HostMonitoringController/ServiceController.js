/**
 * @fileoverview Monitoring Service Controller for Host Monitoring
 * @description Handles monitoring service status, health checks, and manual collection triggers
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { getHostMonitoringService } from '../HostMonitoringService.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /monitoring/status:
 *   get:
 *     summary: Get monitoring service status
 *     description: Returns the current status of the host monitoring service including configuration and statistics
 *     tags: [Host Monitoring]
 *     responses:
 *       200:
 *         description: Monitoring service status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isRunning:
 *                   type: boolean
 *                   description: Whether the monitoring service is currently running
 *                 isInitialized:
 *                   type: boolean
 *                   description: Whether the monitoring service has been initialized
 *                 config:
 *                   type: object
 *                   description: Current monitoring configuration
 *                 stats:
 *                   type: object
 *                   description: Collection statistics and performance metrics
 *                 activeIntervals:
 *                   type: object
 *                   description: Status of collection intervals
 *       500:
 *         description: Failed to get monitoring status
 */
export const getMonitoringStatus = (req, res) => {
  void req;
  try {
    const service = getHostMonitoringService();
    const status = service.getStatus();
    res.json(status);
  } catch (error) {
    log.api.error('Error getting monitoring status', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to get monitoring status',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /monitoring/health:
 *   get:
 *     summary: Get monitoring service health check
 *     description: Returns detailed health information about the monitoring service and recent collection activity
 *     tags: [Host Monitoring]
 *     responses:
 *       200:
 *         description: Health check information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [healthy, stopped, error]
 *                   description: Overall health status
 *                 lastUpdate:
 *                   type: string
 *                   format: date-time
 *                   description: Last time host info was updated
 *                 networkErrors:
 *                   type: integer
 *                   description: Count of consecutive network scan errors
 *                 storageErrors:
 *                   type: integer
 *                   description: Count of consecutive storage scan errors
 *                 recentActivity:
 *                   type: object
 *                   description: Recent collection activity status
 *                 uptime:
 *                   type: integer
 *                   description: System uptime in seconds
 *       500:
 *         description: Failed to get health check
 */
export const getHealthCheck = async (req, res) => {
  void req;
  try {
    const service = getHostMonitoringService();
    const health = await service.getHealthCheck();
    res.json(health);
  } catch (error) {
    log.api.error('Error getting health check', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to get health check',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /monitoring/collect:
 *   post:
 *     summary: Trigger immediate data collection
 *     description: Manually triggers data collection for network, storage, or all types
 *     tags: [Host Monitoring]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [network, storage, all]
 *                 default: all
 *                 description: Type of collection to trigger
 *     responses:
 *       200:
 *         description: Collection triggered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 results:
 *                   type: object
 *                   description: Collection results
 *       500:
 *         description: Failed to trigger collection
 */
export const triggerCollection = async (req, res) => {
  try {
    const { type = 'all' } = req.body;
    const service = getHostMonitoringService();
    const results = await service.triggerCollection(type);

    res.json({
      success: results.errors.length === 0,
      type,
      results,
    });
  } catch (error) {
    log.api.error('Error triggering collection', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to trigger collection',
      details: error.message,
    });
  }
};
