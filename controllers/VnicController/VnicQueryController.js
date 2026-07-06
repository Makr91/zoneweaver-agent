/**
 * @fileoverview VNIC query operations
 */

import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import os from 'os';
import { log } from '../../lib/Logger.js';
import { executeCommand } from './utils/CommandHelper.js';

/**
 * @swagger
 * /network/vnics:
 *   get:
 *     summary: List VNICs
 *     description: Returns VNIC information from monitoring data or live system query
 *     tags: [VNIC Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: over
 *         schema:
 *           type: string
 *         description: Filter by underlying physical link
 *       - in: query
 *         name: zone
 *         schema:
 *           type: string
 *         description: Filter by zone assignment
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *           enum: [up, down, unknown]
 *         description: Filter by VNIC state
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of VNICs to return
 *     responses:
 *       200:
 *         description: VNICs retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vnics:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/NetworkInterface'
 *                 returned:
 *                   type: integer
 *                   description: Number of records in this response
 *                 source:
 *                   type: string
 *                   enum: [database, live]
 *       500:
 *         description: Failed to get VNICs
 */
export const getVNICs = async (req, res) => {
  const { over, zone, state, limit = 100 } = req.query;

  try {
    // Always get data from database (monitoring data)
    const hostname = os.hostname();
    const whereClause = {
      host: hostname,
      class: 'vnic',
    };

    if (over) {
      whereClause.over = over;
    }
    if (zone) {
      whereClause.zone = zone;
    }
    if (state) {
      whereClause.state = state;
    }

    // Optimize: Remove expensive COUNT query, only include existing columns
    const rows = await NetworkInterfaces.findAll({
      where: whereClause,
      attributes: [
        'id',
        'link',
        'class',
        'state',
        'zone',
        'over',
        'speed',
        'duplex',
        'scan_timestamp',
        'vid',
        'macaddress',
        'macaddrtype',
        'mtu',
        'flags',
      ], // Only include columns that exist in database
      limit: parseInt(limit),
      order: [
        ['scan_timestamp', 'DESC'],
        ['link', 'ASC'],
      ],
    });

    return res.json({
      vnics: rows,
      source: 'database',
      returned: rows.length,
    });
  } catch (error) {
    log.api.error('Error getting VNICs', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get VNICs',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/vnics/{vnic}:
 *   get:
 *     summary: Get VNIC details
 *     description: Returns detailed information about a specific VNIC
 *     tags: [VNIC Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: vnic
 *         required: true
 *         schema:
 *           type: string
 *         description: VNIC name
 *     responses:
 *       200:
 *         description: VNIC details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/NetworkInterface'
 *       404:
 *         description: VNIC not found
 *       500:
 *         description: Failed to get VNIC details
 */
export const getVNICDetails = async (req, res) => {
  const { vnic } = req.params;

  try {
    // Always get data from database
    const hostname = os.hostname();
    const vnicData = await NetworkInterfaces.findOne({
      where: {
        host: hostname,
        link: vnic,
        class: 'vnic',
      },
      order: [['scan_timestamp', 'DESC']],
    });

    if (!vnicData) {
      return res.status(404).json({
        error: `VNIC ${vnic} not found`,
      });
    }

    return res.json(vnicData);
  } catch (error) {
    log.api.error('Error getting VNIC details', {
      vnic,
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get VNIC details',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/vnics/{vnic}/stats:
 *   get:
 *     summary: Get VNIC statistics
 *     description: Returns live statistics for a specific VNIC using dladm show-vnic -s
 *     tags: [VNIC Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: vnic
 *         required: true
 *         schema:
 *           type: string
 *         description: VNIC name
 *       - in: query
 *         name: interval
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Interval between samples (for continuous monitoring)
 *     responses:
 *       200:
 *         description: VNIC statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vnic:
 *                   type: string
 *                 statistics:
 *                   type: object
 *                   properties:
 *                     link:
 *                       type: string
 *                     ipackets:
 *                       type: integer
 *                     rbytes:
 *                       type: integer
 *                     ierrors:
 *                       type: integer
 *                     opackets:
 *                       type: integer
 *                     obytes:
 *                       type: integer
 *                     oerrors:
 *                       type: integer
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 interval:
 *                   type: integer
 *                   description: Sampling interval echoed from the request
 *       404:
 *         description: VNIC not found
 *       500:
 *         description: Failed to get VNIC statistics
 */
export const getVNICStats = async (req, res) => {
  const { vnic } = req.params;
  const { interval = 1 } = req.query;

  try {
    // Get live statistics from dladm
    const result = await executeCommand(
      `pfexec dladm show-vnic ${vnic} -s -p -o link,ipackets,rbytes,ierrors,opackets,obytes,oerrors`
    );

    if (!result.success) {
      return res.status(404).json({
        error: `VNIC ${vnic} not found or failed to get statistics`,
        details: result.error,
      });
    }

    const [link, ipackets, rbytes, ierrors, opackets, obytes, oerrors] = result.output.split(':');

    const statistics = {
      link,
      ipackets: parseInt(ipackets) || 0,
      rbytes: parseInt(rbytes) || 0,
      ierrors: parseInt(ierrors) || 0,
      opackets: parseInt(opackets) || 0,
      obytes: parseInt(obytes) || 0,
      oerrors: parseInt(oerrors) || 0,
    };

    return res.json({
      vnic,
      statistics,
      timestamp: new Date().toISOString(),
      interval: parseInt(interval),
    });
  } catch (error) {
    log.api.error('Error getting VNIC statistics', {
      vnic,
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get VNIC statistics',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/vnics/{vnic}/properties:
 *   get:
 *     summary: Get VNIC properties
 *     description: Returns link properties for a specific VNIC using dladm show-linkprop
 *     tags: [VNIC Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: vnic
 *         required: true
 *         schema:
 *           type: string
 *         description: VNIC name
 *       - in: query
 *         name: property
 *         schema:
 *           type: string
 *         description: Specific property to get (omit for all properties)
 *     responses:
 *       200:
 *         description: VNIC properties retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vnic:
 *                   type: string
 *                 properties:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       property:
 *                         type: string
 *                       value:
 *                         type: string
 *                       default:
 *                         type: string
 *                       possible:
 *                         type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: VNIC not found
 *       500:
 *         description: Failed to get VNIC properties
 */
export const getVNICProperties = async (req, res) => {
  const { vnic } = req.params;
  const { property } = req.query;

  try {
    // Build command with optional property filter
    let command = `pfexec dladm show-linkprop ${vnic} -p -o property,value,default,possible`;
    if (property) {
      command += ` -p ${property}`;
    }

    const result = await executeCommand(command);

    if (!result.success) {
      return res.status(404).json({
        error: `VNIC ${vnic} not found or failed to get properties`,
        details: result.error,
      });
    }

    const properties = result.output
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [prop, value, defaultVal, possible] = line.split(':');
        return {
          property: prop,
          value,
          default: defaultVal,
          possible,
        };
      });

    return res.json({
      vnic,
      properties,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error getting VNIC properties', {
      vnic,
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get VNIC properties',
      details: error.message,
    });
  }
};
