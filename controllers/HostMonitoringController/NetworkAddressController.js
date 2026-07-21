/**
 * @fileoverview Network Address Controller for Host Monitoring
 * @description Handles IP address assignments and routing table monitoring
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import IPAddresses from '../../models/IPAddressModel.js';
import Routes from '../../models/RoutingTableModel.js';
import {
  buildNetworkWhereClause,
  IP_ADDRESS_ATTRIBUTES,
  ROUTE_ATTRIBUTES,
} from './utils/QueryHelpers.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /monitoring/network/ipaddresses:
 *   get:
 *     summary: Get IP address assignments
 *     description: Returns IP address assignments from ipadm show-addr
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of records to skip
 *       - in: query
 *         name: interface
 *         schema:
 *           type: string
 *         description: Filter by interface name
 *       - in: query
 *         name: ip_version
 *         schema:
 *           type: string
 *           enum: [v4, v6]
 *         description: Filter by IP version
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *         description: Filter by address state
 *     responses:
 *       200:
 *         description: IP address data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 addresses:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/IPAddress'
 *                 returned:
 *                   type: integer
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *       500:
 *         description: Failed to get IP addresses
 */
export const getIPAddresses = async (req, res) => {
  try {
    const { limit = 100, offset = 0, interface: iface, ip_version, state } = req.query;

    const whereClause = buildNetworkWhereClause({
      interface: iface,
      ip_version,
      state,
    });

    const rows = await IPAddresses.findAll({
      where: whereClause,
      attributes: IP_ADDRESS_ATTRIBUTES,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [
        ['scan_timestamp', 'DESC'],
        ['ip_version', 'ASC'],
        ['interface', 'ASC'],
      ],
    });

    res.json({
      addresses: rows,
      returned: rows.length,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (error) {
    log.api.error('Error getting IP addresses', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to get IP addresses',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /monitoring/network/routes:
 *   get:
 *     summary: Get routing table information
 *     description: Returns routing table entries from netstat -rn
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of records to skip
 *       - in: query
 *         name: interface
 *         schema:
 *           type: string
 *         description: Filter by interface name
 *       - in: query
 *         name: ip_version
 *         schema:
 *           type: string
 *           enum: [v4, v6]
 *         description: Filter by IP version
 *       - in: query
 *         name: is_default
 *         schema:
 *           type: boolean
 *         description: Filter by default routes only
 *       - in: query
 *         name: destination
 *         schema:
 *           type: string
 *         description: Filter by destination (partial match)
 *     responses:
 *       200:
 *         description: Routing table data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 routes:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Route'
 *                 returned:
 *                   type: integer
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *       500:
 *         description: Failed to get routing table
 */
export const getRoutes = async (req, res) => {
  try {
    const {
      limit = 100,
      offset = 0,
      interface: iface,
      ip_version,
      is_default,
      destination,
    } = req.query;

    const whereClause = buildNetworkWhereClause({
      interface: iface,
      ip_version,
      is_default,
      destination,
    });

    const rows = await Routes.findAll({
      where: whereClause,
      attributes: ROUTE_ATTRIBUTES,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [
        ['scan_timestamp', 'DESC'],
        ['ip_version', 'ASC'],
        ['is_default', 'DESC'],
        ['destination', 'ASC'],
      ],
    });

    res.json({
      routes: rows,
      returned: rows.length,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (error) {
    log.api.error('Error getting routing table', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to get routing table',
      details: error.message,
    });
  }
};
