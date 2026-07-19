/**
 * @fileoverview Network Monitoring Controller for Host Monitoring
 * @description Handles network interface monitoring, usage statistics, IP addresses, and routing
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import NetworkUsage from '../../models/NetworkUsageModel.js';
import IPAddresses from '../../models/IPAddressModel.js';
import Routes from '../../models/RoutingTableModel.js';
import { metricsNetworkDb as db } from '../../config/Database.js';
import {
  buildNetworkWhereClause,
  buildPagination,
  NETWORK_INTERFACE_ATTRIBUTES,
  NETWORK_USAGE_ATTRIBUTES,
  IP_ADDRESS_ATTRIBUTES,
  ROUTE_ATTRIBUTES,
} from './utils/QueryHelpers.js';
import {
  getLatestPerEntity,
  buildSamplingMetadata,
  createEmptyResponse,
  addQueryTiming,
} from './utils/SamplingHelpers.js';
import {
  getActiveInterfacesList,
  getTimeSeriesSampledData,
  getFallbackSampledData,
  getDatasetMetadata,
  createOptimizedResponse,
} from './utils/NetworkSamplingHelpers.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /monitoring/network/interfaces:
 *   get:
 *     summary: Get network interface information
 *     description: Returns network interface configuration and status data
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
 *         name: state
 *         schema:
 *           type: string
 *         description: Filter by interface state (up, down)
 *       - in: query
 *         name: link
 *         schema:
 *           type: string
 *         description: Filter by link name
 *     responses:
 *       200:
 *         description: Network interface data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 interfaces:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/NetworkInterface'
 *                 totalCount:
 *                   type: integer
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *                     hasMore:
 *                       type: boolean
 *       500:
 *         description: Failed to get network interfaces
 */
export const getNetworkInterfaces = async (req, res) => {
  try {
    const { limit = 100, offset = 0, state, link } = req.query;

    const whereClause = buildNetworkWhereClause({ state, link });

    const { count, rows } = await NetworkInterfaces.findAndCountAll({
      where: whereClause,
      attributes: NETWORK_INTERFACE_ATTRIBUTES,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [
        ['scan_timestamp', 'DESC'],
        ['link', 'ASC'],
      ],
    });

    res.json({
      interfaces: rows,
      totalCount: count,
      pagination: buildPagination(limit, offset, count),
    });
  } catch (error) {
    log.api.error('Error getting network interfaces', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to get network interfaces',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /monitoring/network/usage:
 *   get:
 *     summary: Get network usage accounting data
 *     description: |
 *       Returns network interface usage data from network accounting. The
 *       per_interface latest-snapshot form is scoped to links that currently
 *       exist on the host — destroyed links never resurrect there; historical
 *       `since=` queries keep their rows for the retention window.
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Return records since this timestamp
 *       - in: query
 *         name: link
 *         schema:
 *           type: string
 *         description: Filter by interface/link name
 *       - in: query
 *         name: per_interface
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Group results per interface (if false, returns raw list)
 *     responses:
 *       200:
 *         description: Network usage data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 usage:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/NetworkUsage'
 *                 totalCount:
 *                   type: integer
 *                 returnedCount:
 *                   type: integer
 *                   description: Number of records in this response
 *                 sampling:
 *                   type: object
 *                   description: Time-series sampling metadata applied to the result set
 *                   properties:
 *                     applied:
 *                       type: boolean
 *                     strategy:
 *                       type: string
 *                     entityCount:
 *                       type: integer
 *                     samplesPerEntity:
 *                       type: integer
 *                 metadata:
 *                   type: object
 *                   description: Present on the latest-per-interface path
 *                   properties:
 *                     activeInterfacesCount:
 *                       type: integer
 *                     interfaceList:
 *                       type: array
 *                       items:
 *                         type: string
 *                 queryTime:
 *                   type: string
 *                   description: Server-side query duration (e.g. "12ms")
 *       500:
 *         description: Failed to get network usage
 */
export const getNetworkUsage = async (req, res) => {
  const startTime = Date.now();

  try {
    const { limit = 100, since, link, per_interface = 'true' } = req.query;
    const requestedLimit = parseInt(limit);

    if (per_interface === 'true') {
      if (!since) {
        // Latest per interface using optimized sampling
        const whereClause = buildNetworkWhereClause({ link });

        const recentRecords = await NetworkUsage.findAll({
          attributes: NETWORK_USAGE_ATTRIBUTES,
          where: whereClause,
          order: [['scan_timestamp', 'DESC']],
        });

        if (recentRecords.length === 0) {
          return res.json(createEmptyResponse(startTime, 'latest-per-interface-fast'));
        }

        const latest = getLatestPerEntity(recentRecords, 'link');
        const liveLinks = new Set(
          (await NetworkInterfaces.findAll({ attributes: ['link'], raw: true })).map(
            row => row.link
          )
        );
        const results = liveLinks.size > 0 ? latest.filter(row => liveLinks.has(row.link)) : latest;
        const activeInterfaces = results.filter(row => row.rx_mbps > 0 || row.tx_mbps > 0).length;

        return res.json(
          addQueryTiming(
            {
              usage: results,
              totalCount: results.length,
              returnedCount: results.length,
              sampling: buildSamplingMetadata({
                applied: true,
                strategy: 'latest-per-interface-fast',
                entityCount: results.length,
                samplesPerEntity: 1,
              }),
              metadata: {
                activeInterfacesCount: activeInterfaces,
                interfaceList: results.map(row => row.link).sort(),
              },
            },
            startTime
          )
        );
      }
      // OPTIMIZED: Historical sampling using database window functions
      try {
        // Step 1: Get dataset metadata in parallel with interface list
        const [metadata, activeInterfaces] = await Promise.all([
          getDatasetMetadata(link, since),
          link ? [link] : getActiveInterfacesList(link),
        ]);

        if (metadata.totalRecords === 0) {
          return res.json(createEmptyResponse(startTime, 'sql-ntile-optimized'));
        }

        // Step 2: Use optimized SQL sampling instead of JavaScript processing
        let sampledData;
        try {
          // Try window function approach first (works on all modern databases)
          sampledData = await getTimeSeriesSampledData(
            Array.isArray(activeInterfaces) ? activeInterfaces : metadata.interfaces,
            since,
            requestedLimit
          );
        } catch (windowError) {
          // Fallback to Sequelize-based sampling for older database versions
          log.database.warn('Window function query failed, using fallback method', {
            error: windowError.message,
            database_dialect: db.getDialect(),
          });

          sampledData = await getFallbackSampledData(
            Array.isArray(activeInterfaces) ? activeInterfaces : metadata.interfaces,
            since,
            requestedLimit
          );
        }

        // Step 3: Create optimized response with performance metrics
        return res.json(createOptimizedResponse(sampledData, metadata, requestedLimit, startTime));
      } catch (optimizationError) {
        // Ultimate fallback: Log error and use original method if optimization fails
        log.database.error('Optimization failed, using original method', {
          error: optimizationError.message,
          stack: optimizationError.stack,
        });

        // Original fallback method (should rarely be used)
        const whereClause = buildNetworkWhereClause({ link, since });
        const { count, rows } = await NetworkUsage.findAndCountAll({
          where: whereClause,
          attributes: NETWORK_USAGE_ATTRIBUTES,
          limit: Math.min(requestedLimit * 10, 1000), // Limit fallback to prevent memory issues
          order: [['scan_timestamp', 'DESC']],
        });

        return res.json(
          addQueryTiming(
            {
              usage: rows,
              totalCount: count,
              returnedCount: rows.length,
              sampling: buildSamplingMetadata({
                applied: true,
                strategy: 'fallback-limited-query',
                note: 'Optimization failed, used limited fallback query',
              }),
            },
            startTime
          )
        );
      }
    }

    // Simple query without per-interface logic
    const whereClause = buildNetworkWhereClause({ link, since });

    const { count, rows } = await NetworkUsage.findAndCountAll({
      where: whereClause,
      attributes: NETWORK_USAGE_ATTRIBUTES,
      limit: requestedLimit,
      order: [['scan_timestamp', 'DESC']],
    });

    return res.json(
      addQueryTiming(
        {
          usage: rows,
          totalCount: count,
          returnedCount: rows.length,
          sampling: buildSamplingMetadata({
            applied: false,
            strategy: 'simple-limit-latest',
          }),
        },
        startTime
      )
    );
  } catch (error) {
    return res.status(500).json(
      addQueryTiming(
        {
          error: 'Failed to get network usage',
          details: error.message,
        },
        startTime
      )
    );
  }
};

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
