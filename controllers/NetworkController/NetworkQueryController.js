/**
 * @fileoverview Network query operations
 */

import IPAddresses from '../../models/IPAddressModel.js';
import { Op } from 'sequelize';
import os from 'os';
import fs from 'fs/promises';
import { log } from '../../lib/Logger.js';
import { executeCommand } from './utils/CommandHelper.js';

/**
 * @swagger
 * /network/hostname:
 *   get:
 *     summary: Get system hostname
 *     description: Returns the current system hostname from /etc/nodename and system
 *     tags: [Network Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Current hostname information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 hostname:
 *                   type: string
 *                   description: Current system hostname
 *                   example: "hv-04"
 *                 nodename_file:
 *                   type: string
 *                   description: Hostname from /etc/nodename
 *                   example: "hv-04"
 *                 system_hostname:
 *                   type: string
 *                   description: Current running system hostname
 *                   example: "hv-04"
 *                 matches:
 *                   type: boolean
 *                   description: Whether nodename file matches system hostname
 *                 warning:
 *                   type: string
 *                   nullable: true
 *                   description: Set when /etc/nodename disagrees with the running hostname; null otherwise
 *       500:
 *         description: Failed to get hostname
 */
export const getHostname = async (req, res) => {
  void req;
  try {
    let nodenameMismatch = false;
    let nodenameFile = null;
    const systemHostname = os.hostname();

    // Read /etc/nodename if it exists
    try {
      nodenameFile = (await fs.readFile('/etc/nodename', 'utf8')).trim();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        log.filesystem.warn('Could not read /etc/nodename', {
          error: error.message,
        });
      }
    }

    // Check for mismatch
    if (nodenameFile && nodenameFile !== systemHostname) {
      nodenameMismatch = true;
    }

    return res.json({
      hostname: systemHostname,
      nodename_file: nodenameFile,
      system_hostname: systemHostname,
      matches: !nodenameMismatch,
      warning: nodenameMismatch ? 'Hostname in /etc/nodename does not match system hostname' : null,
    });
  } catch (error) {
    log.api.error('Error getting hostname', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get hostname',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/addresses:
 *   get:
 *     summary: List IP addresses
 *     description: Returns IP address assignments from monitoring data with optional filtering
 *     tags: [Network Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: interface
 *         schema:
 *           type: string
 *         description: Filter by interface name (partial match)
 *       - in: query
 *         name: ip_version
 *         schema:
 *           type: string
 *           enum: [v4, v6]
 *         description: Filter by IP version
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [static, dhcp, addrconf]
 *         description: Filter by address type
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *         description: Filter by address state
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of addresses to return
 *       - in: query
 *         name: live
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get live data directly from ipadm instead of database
 *     responses:
 *       200:
 *         description: IP addresses retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 addresses:
 *                   type: array
 *                   description: >-
 *                     In database mode (default) each item is a full IPAddress record. In live mode
 *                     (live=true) each item is a reduced shape sourced directly from ipadm:
 *                     { addrobj, interface, type, state, addr, ip_version, source }.
 *                   items:
 *                     $ref: '#/components/schemas/IPAddress'
 *                 total:
 *                   type: integer
 *                 source:
 *                   type: string
 *                   enum: [database, live]
 *       500:
 *         description: Failed to get IP addresses
 */
export const getIPAddresses = async (req, res) => {
  const { interface: iface, ip_version, type, state, limit = 100, live = false } = req.query;

  try {
    if (live === 'true' || live === true) {
      // Get live data directly from ipadm
      const result = await executeCommand('pfexec ipadm show-addr -p -o addrobj,type,state,addr');

      if (!result.success) {
        return res.status(500).json({
          error: 'Failed to get live IP address data',
          details: result.error,
        });
      }

      const addresses = result.output
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          const [addrobj, addrType, addrState, addr] = line.split(':');
          const [interfaceName] = addrobj.split('/');
          const ipVersion = addr.includes(':') ? 'v6' : 'v4';

          return {
            addrobj,
            interface: interfaceName,
            type: addrType,
            state: addrState,
            addr,
            ip_version: ipVersion,
            source: 'live',
          };
        })
        .filter(addr => {
          if (iface && !addr.interface.includes(iface)) {
            return false;
          }
          if (ip_version && addr.ip_version !== ip_version) {
            return false;
          }
          if (type && addr.type !== type) {
            return false;
          }
          if (state && addr.state !== state) {
            return false;
          }
          return true;
        })
        .slice(0, parseInt(limit));

      return res.json({
        addresses,
        total: addresses.length,
        source: 'live',
      });
    }

    // Get data from database (monitoring data)
    const hostname = os.hostname();
    const whereClause = { host: hostname };

    if (iface) {
      whereClause.interface = { [Op.like]: `%${iface}%` };
    }
    if (ip_version) {
      whereClause.ip_version = ip_version;
    }
    if (type) {
      whereClause.type = type;
    }
    if (state) {
      whereClause.state = state;
    }

    const { count, rows } = await IPAddresses.findAndCountAll({
      where: whereClause,
      limit: parseInt(limit),
      order: [
        ['scan_timestamp', 'DESC'],
        ['ip_version', 'ASC'],
        ['interface', 'ASC'],
      ],
    });

    return res.json({
      addresses: rows,
      total: count,
      source: 'database',
    });
  } catch (error) {
    log.api.error('Error getting IP addresses', {
      error: error.message,
      stack: error.stack,
      live,
      interface: iface,
    });
    return res.status(500).json({
      error: 'Failed to get IP addresses',
      details: error.message,
    });
  }
};
