/**
 * @fileoverview Host Devices API Controller for Zoneweaver Agent
 * @description Handles API endpoints for PCI device inventory and passthrough capabilities
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import PCIDevices from '../models/PCIDeviceModel.js';
import { Op } from 'sequelize';
import os from 'os';
import { log } from '../lib/Logger.js';
import { isPPTCapable } from './HostDevices/HostDevicesUtils.js';

/**
 * @swagger
 * /host/devices:
 *   get:
 *     summary: List all PCI devices
 *     description: Retrieves a list of all PCI devices with optional filtering
 *     tags: [Host Devices]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *           enum: [network, storage, display, usb, audio, other]
 *         description: Filter by device category
 *       - in: query
 *         name: ppt_enabled
 *         schema:
 *           type: boolean
 *         description: Filter by PPT enabled status
 *       - in: query
 *         name: ppt_capable
 *         schema:
 *           type: boolean
 *         description: Filter by PPT capability
 *       - in: query
 *         name: driver_attached
 *         schema:
 *           type: boolean
 *         description: Filter by driver attachment status
 *       - in: query
 *         name: available
 *         schema:
 *           type: boolean
 *         description: Show only devices not assigned to zones
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of devices to return
 *     responses:
 *       200:
 *         description: Devices retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 devices:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/PCIDevice'
 *                 summary:
 *                   type: object
 *                   properties:
 *                     total_devices:
 *                       type: integer
 *                     by_category:
 *                       type: object
 *                     ppt_capable:
 *                       type: integer
 *                     ppt_assigned:
 *                       type: integer
 *                     zones_using_passthrough:
 *                       type: array
 *                       items:
 *                         type: string
 */
export const listDevices = async (req, res) => {
  const { category, ppt_enabled, ppt_capable, driver_attached, available, limit = 100 } = req.query;

  const hostname = os.hostname();

  try {
    const whereClause = { host: hostname };

    if (category) {
      whereClause.device_category = category;
    }

    if (ppt_enabled !== undefined) {
      whereClause.ppt_enabled = ppt_enabled === 'true';
    }

    if (ppt_capable !== undefined) {
      whereClause.ppt_capable = ppt_capable === 'true';
    }

    if (driver_attached !== undefined) {
      whereClause.driver_attached = driver_attached === 'true';
    }

    if (available === 'true') {
      whereClause.assigned_to_zones = { [Op.or]: [null, []] };
    }

    const devices = await PCIDevices.findAll({
      where: whereClause,
      order: [
        ['device_category', 'ASC'],
        ['vendor_name', 'ASC'],
        ['device_name', 'ASC'],
      ],
      limit: parseInt(limit),
    });

    const allDevices = await PCIDevices.findAll({
      where: { host: hostname },
      attributes: ['device_category', 'vendor_id', 'ppt_enabled', 'assigned_to_zones'],
    });

    const summary = {
      total_devices: allDevices.length,
      by_category: {},
      ppt_capable: 0,
      ppt_assigned: 0,
      zones_using_passthrough: [],
    };

    const zonesSet = new Set();

    allDevices.forEach(device => {
      const deviceCategory = device.device_category || 'other';
      summary.by_category[deviceCategory] = (summary.by_category[deviceCategory] || 0) + 1;

      if (isPPTCapable(device)) {
        summary.ppt_capable++;
      }

      if (device.ppt_enabled) {
        if (
          device.assigned_to_zones &&
          Array.isArray(device.assigned_to_zones) &&
          device.assigned_to_zones.length > 0
        ) {
          summary.ppt_assigned++;
          device.assigned_to_zones.forEach(assignment => {
            if (assignment.zone_name) {
              zonesSet.add(assignment.zone_name);
            }
          });
        }
      }
    });

    summary.zones_using_passthrough = Array.from(zonesSet);

    return res.json({
      devices,
      summary,
    });
  } catch (error) {
    log.api.error('Error listing devices', {
      error: error.message,
      stack: error.stack,
      hostname,
      filters: { category, ppt_enabled, ppt_capable, driver_attached, available },
    });
    return res.status(500).json({ error: 'Failed to retrieve devices' });
  }
};

/**
 * @swagger
 * /host/devices/available:
 *   get:
 *     summary: List available devices for passthrough
 *     description: Retrieves devices that are available for passthrough (not assigned to zones)
 *     tags: [Host Devices]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *           enum: [network, storage, display, usb, audio, other]
 *         description: Filter by device category
 *       - in: query
 *         name: ppt_only
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Show only PPT-enabled devices
 *     responses:
 *       200:
 *         description: Available devices retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 available_devices:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/PCIDevice'
 *                 total:
 *                   type: integer
 */
export const listAvailableDevices = async (req, res) => {
  const { category, ppt_only = false } = req.query;
  const hostname = os.hostname();

  try {
    const whereClause = {
      host: hostname,
      assigned_to_zones: { [Op.or]: [null, []] },
    };

    if (category) {
      whereClause.device_category = category;
    }

    if (ppt_only === 'true') {
      whereClause.ppt_enabled = true;
    }

    const devices = await PCIDevices.findAll({
      where: whereClause,
      order: [
        ['device_category', 'ASC'],
        ['ppt_enabled', 'DESC'],
        ['vendor_name', 'ASC'],
      ],
    });

    return res.json({
      available_devices: devices,
      total: devices.length,
    });
  } catch (error) {
    log.api.error('Error listing available devices', {
      error: error.message,
      stack: error.stack,
      hostname,
      category,
      ppt_only,
    });
    return res.status(500).json({ error: 'Failed to retrieve available devices' });
  }
};

/**
 * @swagger
 * /host/devices/{deviceId}:
 *   get:
 *     summary: Get device details
 *     description: Retrieves detailed information about a specific PCI device
 *     tags: [Host Devices]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema:
 *           type: string
 *         description: Device ID or PCI address
 *     responses:
 *       200:
 *         description: Device details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PCIDevice'
 *       404:
 *         description: Device not found
 */
export const getDeviceDetails = async (req, res) => {
  const { deviceId } = req.params;
  const hostname = os.hostname();

  try {
    const device = await PCIDevices.findOne({
      where: {
        host: hostname,
        [Op.or]: [{ id: deviceId }, { pci_address: deviceId }],
      },
    });

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    return res.json(device);
  } catch (error) {
    log.api.error('Error getting device details', {
      error: error.message,
      stack: error.stack,
      device_id: deviceId,
      hostname,
    });
    return res.status(500).json({ error: 'Failed to retrieve device details' });
  }
};

/**
 * @swagger
 * /host/devices/categories:
 *   get:
 *     summary: Get device categories summary
 *     description: Retrieves a summary of devices grouped by category
 *     tags: [Host Devices]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Categories summary retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 categories:
 *                   type: object
 */
export const getDeviceCategories = async (req, res) => {
  void req;
  const hostname = os.hostname();

  try {
    const devices = await PCIDevices.findAll({
      where: { host: hostname },
      attributes: [
        'device_category',
        'vendor_id',
        'ppt_enabled',
        'driver_attached',
        'assigned_to_zones',
      ],
    });

    const categories = {};

    devices.forEach(device => {
      const category = device.device_category || 'other';

      if (!categories[category]) {
        categories[category] = {
          total: 0,
          ppt_capable: 0,
          driver_attached: 0,
          available: 0,
          assigned: 0,
        };
      }

      categories[category].total++;

      if (isPPTCapable(device)) {
        categories[category].ppt_capable++;
      }

      if (device.driver_attached) {
        categories[category].driver_attached++;
      }

      if (!device.assigned_to_zones || device.assigned_to_zones.length === 0) {
        categories[category].available++;
      } else {
        categories[category].assigned++;
      }
    });

    return res.json({
      categories,
      total_devices: devices.length,
    });
  } catch (error) {
    log.api.error('Error getting device categories', {
      error: error.message,
      stack: error.stack,
      hostname,
    });
    return res.status(500).json({ error: 'Failed to retrieve device categories' });
  }
};

/**
 * @swagger
 * /host/ppt-status:
 *   get:
 *     summary: Get PPT status
 *     description: Retrieves current PPT (PCI passthrough) status and assignments
 *     tags: [Host Devices]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: PPT status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ppt_devices:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/PCIDevice'
 *                 summary:
 *                   type: object
 */
export const getPPTStatus = async (req, res) => {
  void req;
  const hostname = os.hostname();

  try {
    const pptDevices = await PCIDevices.findAll({
      where: {
        host: hostname,
        ppt_enabled: true,
      },
      order: [['ppt_device_path', 'ASC']],
    });

    const summary = {
      total_ppt_devices: pptDevices.length,
      available: 0,
      assigned_to_zones: 0,
      zone_assignments: {},
    };

    pptDevices.forEach(device => {
      if (!device.assigned_to_zones || device.assigned_to_zones.length === 0) {
        summary.available++;
      } else {
        summary.assigned_to_zones++;
        device.assigned_to_zones.forEach(assignment => {
          if (!summary.zone_assignments[assignment.zone_name]) {
            summary.zone_assignments[assignment.zone_name] = [];
          }
          summary.zone_assignments[assignment.zone_name].push({
            device_name: device.device_name,
            ppt_device_path: device.ppt_device_path,
            assignment_type: assignment.assignment_type,
          });
        });
      }
    });

    return res.json({
      ppt_devices: pptDevices,
      summary,
    });
  } catch (error) {
    log.api.error('Error getting PPT status', {
      error: error.message,
      stack: error.stack,
      hostname,
    });
    return res.status(500).json({ error: 'Failed to retrieve PPT status' });
  }
};

/**
 * @swagger
 * /host/devices/refresh:
 *   post:
 *     summary: Trigger device discovery
 *     description: Manually triggers a device discovery scan
 *     tags: [Host Devices]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Device discovery triggered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 devices_found:
 *                   type: integer
 */
export const triggerDeviceDiscovery = async (req, res) => {
  void req;
  const hostname = os.hostname();

  try {
    const { getHostMonitoringService } = await import('./HostMonitoringService.js');
    const hostMonitoringService = getHostMonitoringService();

    const result = await hostMonitoringService.triggerCollection('devices');

    if (result.errors && result.errors.length > 0) {
      return res.status(500).json({
        success: false,
        message: 'Device discovery completed with errors',
        errors: result.errors,
      });
    }

    const devicesFound = await PCIDevices.count({
      where: {
        host: hostname,
        scan_timestamp: {
          [Op.gte]: new Date(Date.now() - 5 * 60 * 1000),
        },
      },
    });

    return res.json({
      success: true,
      message: 'Device discovery completed successfully',
      devices_found: devicesFound,
    });
  } catch (error) {
    log.api.error('Error triggering device discovery', {
      error: error.message,
      stack: error.stack,
      hostname,
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to trigger device discovery',
      details: error.message,
    });
  }
};
