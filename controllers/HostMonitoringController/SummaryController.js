/**
 * @fileoverview Summary Controller for Host Monitoring
 * @description Handles monitoring summary, host info, and aggregated monitoring data
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { Op } from 'sequelize';
import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import NetworkUsage from '../../models/NetworkUsageModel.js';
import IPAddresses from '../../models/IPAddressModel.js';
import Routes from '../../models/RoutingTableModel.js';
import ZFSPools from '../../models/ZFSPoolModel.js';
import ZFSDatasets from '../../models/ZFSDatasetModel.js';
import Disks from '../../models/DiskModel.js';
import HostInfo from '../../models/HostInfoModel.js';
import os from 'os';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /monitoring/host:
 *   get:
 *     summary: Get host information
 *     description: Returns general host information and monitoring status
 *     tags: [Host Monitoring]
 *     responses:
 *       200:
 *         description: Host information
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HostInfo'
 *       404:
 *         description: Host not found
 *       500:
 *         description: Failed to get host information
 */
export const getHostInfo = async (req, res) => {
  void req;
  try {
    const hostInfo = await HostInfo.findOne({
      order: [['updated_at', 'DESC']],
    });

    if (!hostInfo) {
      return res.status(404).json({
        error: 'Host information not found',
      });
    }

    return res.json(hostInfo);
  } catch (error) {
    log.api.error('Error getting host info', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get host information',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /monitoring/summary:
 *   get:
 *     summary: Get monitoring summary
 *     description: Returns a summary of recent monitoring data including counts and latest timestamps
 *     tags: [Host Monitoring]
 *     responses:
 *       200:
 *         description: Monitoring summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 host:
 *                   type: string
 *                   description: Host name
 *                 summary:
 *                   type: object
 *                   description: Summary statistics
 *                 lastCollected:
 *                   type: object
 *                   description: Timestamps of last data collection
 *                 recordCounts:
 *                   type: object
 *                   description: Count of records in each table
 *       500:
 *         description: Failed to get monitoring summary
 */
export const getMonitoringSummary = async (req, res) => {
  void req;
  const startTime = Date.now();
  log.monitoring.debug('Monitoring summary query started');

  try {
    const hostname = os.hostname();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    log.monitoring.debug('Using optimized summary query');

    // Step 1: Get host info with selective attributes
    const hostInfoQuery = Date.now();
    const hostInfo = await HostInfo.findOne({
      order: [['updated_at', 'DESC']],
      attributes: [
        'network_acct_enabled',
        'network_scan_errors',
        'storage_scan_errors',
        'platform',
        'uptime',
        'last_network_scan',
        'last_network_stats_scan',
        'last_network_usage_scan',
        'last_storage_scan',
      ],
    });
    log.monitoring.debug('Host info query completed', {
      duration_ms: Date.now() - hostInfoQuery,
    });

    // Step 2: Parallel count queries for the last 24 hours
    const countQuery = Date.now();
    const [
      interfaceCount,
      usageCount,
      ipAddressCount,
      routeCount,
      poolCount,
      datasetCount,
      diskCount,
    ] = await Promise.all([
      NetworkInterfaces.count({
        where: {
          scan_timestamp: { [Op.gte]: oneDayAgo },
        },
      }),
      NetworkUsage.count({
        where: {
          scan_timestamp: { [Op.gte]: oneDayAgo },
        },
      }),
      IPAddresses.count({
        where: {
          scan_timestamp: { [Op.gte]: oneDayAgo },
        },
      }),
      Routes.count({
        where: {
          scan_timestamp: { [Op.gte]: oneDayAgo },
        },
      }),
      ZFSPools.count({
        where: {
          scan_timestamp: { [Op.gte]: oneDayAgo },
        },
      }),
      ZFSDatasets.count({
        where: {
          scan_timestamp: { [Op.gte]: oneDayAgo },
        },
      }),
      Disks.count({
        where: {
          scan_timestamp: { [Op.gte]: oneDayAgo },
        },
      }),
    ]);
    log.monitoring.debug('Count queries completed', {
      duration_ms: Date.now() - countQuery,
    });

    // Step 3: Parallel latest timestamp queries with minimal attributes
    const latestQuery = Date.now();
    const [
      latestInterface,
      latestUsage,
      latestIPAddress,
      latestRoute,
      latestPool,
      latestDataset,
      latestDisk,
    ] = await Promise.all([
      NetworkInterfaces.findOne({
        order: [['scan_timestamp', 'DESC']],
        attributes: ['scan_timestamp'],
      }),
      NetworkUsage.findOne({
        order: [['scan_timestamp', 'DESC']],
        attributes: ['scan_timestamp'],
      }),
      IPAddresses.findOne({
        order: [['scan_timestamp', 'DESC']],
        attributes: ['scan_timestamp'],
      }),
      Routes.findOne({
        order: [['scan_timestamp', 'DESC']],
        attributes: ['scan_timestamp'],
      }),
      ZFSPools.findOne({
        order: [['scan_timestamp', 'DESC']],
        attributes: ['scan_timestamp'],
      }),
      ZFSDatasets.findOne({
        order: [['scan_timestamp', 'DESC']],
        attributes: ['scan_timestamp'],
      }),
      Disks.findOne({
        order: [['scan_timestamp', 'DESC']],
        attributes: ['scan_timestamp'],
      }),
    ]);
    log.monitoring.debug('Latest timestamp queries completed', {
      duration_ms: Date.now() - latestQuery,
    });

    const queryTime = Date.now() - startTime;
    log.monitoring.info('Summary query completed', {
      total_duration_ms: queryTime,
    });

    res.json({
      host: hostname,
      summary: {
        networkAccountingEnabled: hostInfo?.network_acct_enabled || false,
        networkErrors: hostInfo?.network_scan_errors || 0,
        storageErrors: hostInfo?.storage_scan_errors || 0,
        platform: hostInfo?.platform,
        uptime: hostInfo?.uptime,
      },
      lastCollected: {
        networkInterfaces: hostInfo?.last_network_scan,
        networkUsage: hostInfo?.last_network_usage_scan,
        storage: hostInfo?.last_storage_scan,
      },
      recordCounts: {
        networkInterfaces: interfaceCount,
        networkUsage: usageCount,
        ipAddresses: ipAddressCount,
        routes: routeCount,
        zfsPools: poolCount,
        zfsDatasets: datasetCount,
        disks: diskCount,
      },
      latestData: {
        networkInterfaces: latestInterface?.scan_timestamp,
        networkUsage: latestUsage?.scan_timestamp,
        ipAddresses: latestIPAddress?.scan_timestamp,
        routes: latestRoute?.scan_timestamp,
        zfsPools: latestPool?.scan_timestamp,
        zfsDatasets: latestDataset?.scan_timestamp,
        disks: latestDisk?.scan_timestamp,
      },
      queryTime: `${queryTime}ms`,
    });
  } catch (error) {
    const queryTime = Date.now() - startTime;
    log.api.error('Summary query failed', {
      duration_ms: queryTime,
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to get monitoring summary',
      details: error.message,
      queryTime: `${queryTime}ms`,
    });
  }
};
