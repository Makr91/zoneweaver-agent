/**
 * @fileoverview Host Devices status API Controller for Zoneweaver Agent
 * @description Device category summaries, PPT status, and device discovery refresh
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
