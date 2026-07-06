/**
 * @fileoverview Link aggregation query endpoints — list, details, and live
 * statistics via dladm.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { execSync } from 'child_process';
import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import os from 'os';
import { log } from '../../lib/Logger.js';

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @returns {{success: boolean, output?: string, error?: string}}
 */
const executeCommand = command => {
  try {
    const output = execSync(command, {
      encoding: 'utf8',
      timeout: 30000, // 30 second timeout
    });
    return { success: true, output: output.trim() };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      output: error.stdout || '',
    };
  }
};

/**
 * @swagger
 * /network/aggregates:
 *   get:
 *     summary: List link aggregations
 *     description: Returns link aggregation information from monitoring data or live system query
 *     tags: [Link Aggregation]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *           enum: [up, down, unknown]
 *         description: Filter by aggregate state
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of aggregates to return
 *     responses:
 *       200:
 *         description: Aggregates retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 aggregates:
 *                   type: array
 *                   items:
 *                     type: object
 *                 returned:
 *                   type: integer
 *                   description: Number of records in this response
 *                 source:
 *                   type: string
 *                   enum: [database, live]
 *       500:
 *         description: Failed to get aggregates
 */
export const getAggregates = async (req, res) => {
  try {
    const { state, limit = 100 } = req.query;

    // Always get data from database (monitoring data) - only get the latest record per aggregate
    const hostname = os.hostname();
    const whereClause = {
      host: hostname,
      class: 'aggr',
    };

    if (state) {
      whereClause.state = state;
    }

    // Optimize: Simple query with selective fetching, only existing columns
    const rows = await NetworkInterfaces.findAll({
      where: whereClause,
      attributes: [
        'id',
        'link',
        'class',
        'state',
        'policy',
        'scan_timestamp',
        'over',
        'lacp_activity',
        'flags',
      ], // Only include columns that exist in database
      limit: parseInt(limit),
      order: [
        ['scan_timestamp', 'DESC'],
        ['link', 'ASC'],
      ],
    });

    return res.json({
      aggregates: rows,
      source: 'database',
      returned: rows.length,
    });
  } catch (error) {
    log.api.error('Error getting aggregates', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get aggregates',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/aggregates/{aggregate}:
 *   get:
 *     summary: Get aggregate details
 *     description: Returns detailed information about a specific link aggregate
 *     tags: [Link Aggregation]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: aggregate
 *         required: true
 *         schema:
 *           type: string
 *         description: Aggregate link name
 *     responses:
 *       200:
 *         description: Aggregate details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       404:
 *         description: Aggregate not found
 *       500:
 *         description: Failed to get aggregate details
 */
export const getAggregateDetails = async (req, res) => {
  try {
    const { aggregate } = req.params;

    // Always get data from database
    log.api.debug('Getting aggregate details from database', { aggregate });
    const hostname = os.hostname();
    const aggregateData = await NetworkInterfaces.findOne({
      where: {
        host: hostname,
        link: aggregate,
        class: 'aggr',
      },
      order: [['scan_timestamp', 'DESC']],
    });

    if (!aggregateData) {
      log.api.warn('Aggregate not found in database', { aggregate });
      return res.status(404).json({
        error: `Aggregate ${aggregate} not found`,
      });
    }

    log.api.debug('Aggregate data retrieved from database', { aggregate });
    return res.json(aggregateData);
  } catch (error) {
    log.api.error('Error getting aggregate details', {
      aggregate: req.params.aggregate,
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get aggregate details',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/aggregates/{aggregate}/stats:
 *   get:
 *     summary: Get aggregate statistics
 *     description: Returns live statistics for a specific aggregate using dladm show-aggr -s
 *     tags: [Link Aggregation]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: aggregate
 *         required: true
 *         schema:
 *           type: string
 *         description: Aggregate name
 *       - in: query
 *         name: interval
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Interval between samples (for continuous monitoring)
 *     responses:
 *       200:
 *         description: Aggregate statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 aggregate:
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
 *         description: Aggregate not found
 *       500:
 *         description: Failed to get aggregate statistics
 */
export const getAggregateStats = (req, res) => {
  try {
    const { aggregate } = req.params;
    const { interval = 1 } = req.query;

    // Get live statistics from dladm
    const result = executeCommand(
      `pfexec dladm show-aggr ${aggregate} -s -p -o link,ipackets,rbytes,ierrors,opackets,obytes,oerrors`
    );

    if (!result.success) {
      return res.status(404).json({
        error: `Aggregate ${aggregate} not found or failed to get statistics`,
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
      aggregate,
      statistics,
      timestamp: new Date().toISOString(),
      interval: parseInt(interval),
    });
  } catch (error) {
    log.api.error('Error getting aggregate statistics', {
      aggregate: req.params.aggregate,
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get aggregate statistics',
      details: error.message,
    });
  }
};
