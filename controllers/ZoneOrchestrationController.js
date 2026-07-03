/**
 * @fileoverview Zone Orchestration Controller
 * @description HTTP endpoints for zone orchestration management
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import {
  getOrchestrationStatus,
  enableZoneOrchestration,
  disableZoneOrchestration,
  getZonesForOrchestration,
} from '../lib/ZoneOrchestrationManager.js';
import { log } from '../lib/Logger.js';

/**
 * @swagger
 * /zones/orchestration/status:
 *   get:
 *     summary: Get zone orchestration status
 *     description: Check who is currently controlling zone lifecycle management
 *     tags: [Zone Orchestration]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Orchestration status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 orchestration_enabled:
 *                   type: boolean
 *                   description: Whether Zoneweaver controls zone lifecycle
 *                 zones_service_enabled:
 *                   type: boolean
 *                   description: Whether system zones service is enabled
 *                 controller:
 *                   type: string
 *                   description: Current zone lifecycle controller
 *                   enum: [system/zones, zoneweaver-agent, unknown]
 *       500:
 *         description: Failed to retrieve orchestration status
 */
export const getZoneOrchestrationStatus = async (req, res) => {
  void req;
  try {
    const status = await getOrchestrationStatus();

    return res.json({
      success: true,
      message: 'Zone orchestration status retrieved successfully',
      ...status,
    });
  } catch (error) {
    log.api.error('Error getting zone orchestration status', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve orchestration status',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /zones/orchestration/enable:
 *   post:
 *     summary: Enable zone orchestration
 *     description: |
 *       Take control of zone lifecycle from system zones service.
 *       **WARNING**: This disables the native zones service and gives Zoneweaver full control.
 *     tags: [Zone Orchestration]
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
 *                 description: Confirmation that orchestration control is intended
 *                 default: false
 *     responses:
 *       200:
 *         description: Zone orchestration enabled successfully
 *       400:
 *         description: Missing confirmation
 *       500:
 *         description: Failed to enable zone orchestration
 */
export const enableOrchestration = async (req, res) => {
  try {
    const { confirm = false } = req.body;

    if (!confirm) {
      return res.status(400).json({
        success: false,
        error: 'Confirmation required',
        details: 'You must set "confirm": true to enable zone orchestration',
      });
    }

    const result = await enableZoneOrchestration();

    if (result.success) {
      log.monitoring.warn('Zone orchestration enabled via API', {
        enabled_by: req.entity.name,
      });

      return res.json({
        success: true,
        message: result.message,
        enabled_by: req.entity.name,
      });
    }

    return res.status(500).json({
      success: false,
      error: result.error,
    });
  } catch (error) {
    log.api.error('Error enabling zone orchestration', {
      error: error.message,
      stack: error.stack,
      requested_by: req.entity?.name,
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to enable zone orchestration',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /zones/orchestration/disable:
 *   post:
 *     summary: Disable zone orchestration
 *     description: Return zone lifecycle control to the native system zones service
 *     tags: [Zone Orchestration]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Zone orchestration disabled successfully
 *       500:
 *         description: Failed to disable zone orchestration
 */
export const disableOrchestration = async (req, res) => {
  try {
    const result = await disableZoneOrchestration();

    if (result.success) {
      log.monitoring.info('Zone orchestration disabled via API', {
        disabled_by: req.entity.name,
      });

      return res.json({
        success: true,
        message: result.message,
        disabled_by: req.entity.name,
      });
    }

    return res.status(500).json({
      success: false,
      error: result.error,
    });
  } catch (error) {
    log.api.error('Error disabling zone orchestration', {
      error: error.message,
      stack: error.stack,
      requested_by: req.entity?.name,
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to disable zone orchestration',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /zones/priorities:
 *   get:
 *     summary: List all zones with their priorities
 *     description: Returns all zones with their current priorities from zonecfg attributes
 *     tags: [Zone Orchestration]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Zone priorities retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 zones:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       priority:
 *                         type: integer
 *                         description: Zone priority (1-100)
 *                       state:
 *                         type: string
 *                       has_custom_priority:
 *                         type: boolean
 *                         description: Whether zone has custom boot_priority attribute
 *                 total_zones:
 *                   type: integer
 *                 priority_groups:
 *                   type: object
 *                   description: Zones grouped by priority ranges
 *       500:
 *         description: Failed to retrieve zone priorities
 */
export const getZonePriorities = async (req, res) => {
  void req;
  try {
    const zonesResult = await getZonesForOrchestration('running');

    if (!zonesResult.success) {
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve zone configurations',
        details: zonesResult.error,
      });
    }

    // Group zones by priority for display
    const priorityGroups = {};

    zonesResult.zones.forEach(zone => {
      const priorityRange = Math.floor((zone.priority - 1) / 10) * 10 + 10;
      if (!priorityGroups[priorityRange]) {
        priorityGroups[priorityRange] = [];
      }
      priorityGroups[priorityRange].push({
        name: zone.name,
        priority: zone.priority,
        state: zone.state,
      });
    });

    return res.json({
      success: true,
      message: 'Zone priorities retrieved successfully',
      zones: zonesResult.zones.map(zone => ({
        name: zone.name,
        priority: zone.priority,
        state: zone.state,
        has_custom_priority: zone.priority !== 95,
      })),
      total_zones: zonesResult.zones.length,
      priority_groups: priorityGroups,
    });
  } catch (error) {
    log.api.error('Error getting zone priorities', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve zone priorities',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /zones/orchestration/test:
 *   post:
 *     summary: Test zone orchestration without executing
 *     description: |
 *       Performs a dry run of zone orchestration to show what would happen.
 *       No zones are actually stopped - this just calculates and returns the execution plan.
 *     tags: [Zone Orchestration]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               strategy:
 *                 type: string
 *                 enum: [sequential, parallel_by_priority, staggered]
 *                 description: Zone shutdown strategy to test
 *                 default: parallel_by_priority
 *     responses:
 *       200:
 *         description: Orchestration test completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 execution_plan:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       priority_range:
 *                         type: integer
 *                       zones:
 *                         type: array
 *                         items:
 *                           type: object
 *                 total_zones:
 *                   type: integer
 *                 estimated_duration:
 *                   type: integer
 *       500:
 *         description: Failed to test orchestration
 */
export const testOrchestration = async (req, res) => {
  try {
    const { strategy = 'parallel_by_priority' } = req.body;

    // Get zones and calculate execution plan without executing
    const zonesResult = await getZonesForOrchestration('running');

    if (!zonesResult.success) {
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve zone configurations for test',
        details: zonesResult.error,
      });
    }

    if (zonesResult.zones.length === 0) {
      return res.json({
        success: true,
        message: 'No running zones found - nothing to orchestrate',
        execution_plan: [],
        total_zones: 0,
        estimated_duration: 0,
      });
    }

    // Import here to avoid circular dependency
    const { calculateShutdownOrder } = await import('../lib/ZoneOrchestrationUtils.js');
    const executionPlan = calculateShutdownOrder(zonesResult.zones);

    // Estimate duration
    const estimatedDuration =
      executionPlan.length * 30 + // 30s between groups
      Math.max(...executionPlan.map(group => group.zones.length)) * 120; // Max 120s per zone

    log.monitoring.info('Zone orchestration test performed', {
      strategy,
      total_zones: zonesResult.zones.length,
      priority_groups: executionPlan.length,
      estimated_duration: estimatedDuration,
      tested_by: req.entity.name,
    });

    return res.json({
      success: true,
      message: `Zone orchestration test completed - ${zonesResult.zones.length} zones would be orchestrated`,
      execution_plan: executionPlan,
      total_zones: zonesResult.zones.length,
      estimated_duration: estimatedDuration,
      strategy,
    });
  } catch (error) {
    log.api.error('Error testing zone orchestration', {
      error: error.message,
      stack: error.stack,
      tested_by: req.entity?.name,
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to test orchestration',
      details: error.message,
    });
  }
};
