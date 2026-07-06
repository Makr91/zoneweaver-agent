/**
 * @fileoverview Bridge query endpoints
 */

import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import os from 'os';
import { log } from '../../lib/Logger.js';
import { executeCommand } from './utils/CommandHelper.js';
import { parseLiveBridgeData } from './utils/ParsingHelpers.js';
import { fetchLiveBridgeDetails } from './utils/DataFetchHelper.js';

/**
 * @swagger
 * /network/bridges:
 *   get:
 *     summary: List bridges
 *     description: Returns bridge information from monitoring data or live system query
 *     tags: [Bridges]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *         description: Filter by bridge name
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of bridges to return
 *       - in: query
 *         name: live
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get live data directly from dladm instead of database
 *       - in: query
 *         name: extended
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include detailed bridge information
 *     responses:
 *       200:
 *         description: Bridges retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 bridges:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 source:
 *                   type: string
 *                   enum: [database, live]
 *                 extended:
 *                   type: boolean
 *                   description: Present in live mode; echoes whether extended bridge fields were requested
 *       500:
 *         description: Failed to get bridges
 */
export const getBridges = async (req, res) => {
  const { name, limit = 100, live = false, extended = false } = req.query;

  try {
    if (live === 'true' || live === true) {
      // Get live data directly from dladm
      let command = 'pfexec dladm show-bridge -p';
      if (extended === 'true' || extended === true) {
        command +=
          ' -o bridge,address,priority,bmaxage,bhellotime,bfwddelay,forceproto,tctime,tccount,tchange,desroot,rootcost,rootport';
      } else {
        command += ' -o bridge,address,priority,desroot';
      }

      if (name) {
        command += ` ${name}`;
      }

      const result = await executeCommand(command);

      if (!result.success) {
        return res.status(500).json({
          error: 'Failed to get live bridge data',
          details: result.error,
        });
      }

      const bridges = parseLiveBridgeData(result.output, extended, limit);

      return res.json({
        bridges,
        total: bridges.length,
        source: 'live',
        extended: extended === 'true' || extended === true,
      });
    }

    // Get data from database (monitoring data)
    const hostname = os.hostname();
    const whereClause = {
      host: hostname,
      class: 'bridge',
    };

    if (name) {
      whereClause.link = name;
    }

    const { count, rows } = await NetworkInterfaces.findAndCountAll({
      where: whereClause,
      limit: parseInt(limit),
      order: [
        ['scan_timestamp', 'DESC'],
        ['link', 'ASC'],
      ],
    });

    return res.json({
      bridges: rows,
      total: count,
      source: 'database',
    });
  } catch (error) {
    log.api.error('Error getting bridges', {
      error: error.message,
      stack: error.stack,
      live,
      name,
    });
    return res.status(500).json({
      error: 'Failed to get bridges',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/bridges/{bridge}:
 *   get:
 *     summary: Get bridge details
 *     description: Returns detailed information about a specific bridge
 *     tags: [Bridges]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: bridge
 *         required: true
 *         schema:
 *           type: string
 *         description: Bridge name
 *       - in: query
 *         name: live
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get live data directly from dladm
 *       - in: query
 *         name: show_links
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include attached links information
 *       - in: query
 *         name: show_forwarding
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include forwarding table entries
 *     responses:
 *       200:
 *         description: Bridge details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       404:
 *         description: Bridge not found
 *       500:
 *         description: Failed to get bridge details
 */
export const getBridgeDetails = async (req, res) => {
  const { bridge } = req.params;
  const { live = false, show_links = false, show_forwarding = false } = req.query;

  try {
    if (live === 'true' || live === true) {
      const bridgeDetails = await fetchLiveBridgeDetails(bridge, show_links, show_forwarding);

      if (bridgeDetails.error) {
        return res.status(404).json(bridgeDetails);
      }

      return res.json(bridgeDetails);
    }

    // Get data from database
    const hostname = os.hostname();
    const bridgeData = await NetworkInterfaces.findOne({
      where: {
        host: hostname,
        link: bridge,
        class: 'bridge',
      },
      order: [['scan_timestamp', 'DESC']],
    });

    if (!bridgeData) {
      return res.status(404).json({
        error: `Bridge ${bridge} not found`,
      });
    }

    return res.json(bridgeData);
  } catch (error) {
    log.api.error('Error getting bridge details', {
      error: error.message,
      stack: error.stack,
      bridge,
      live,
    });
    return res.status(500).json({
      error: 'Failed to get bridge details',
      details: error.message,
    });
  }
};
