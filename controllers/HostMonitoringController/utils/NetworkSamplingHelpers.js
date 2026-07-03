/**
 * @fileoverview Optimized Network Sampling Helper Utilities
 * @description High-performance time-series sampling using database window functions
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { QueryTypes, Op } from 'sequelize';
import db from '../../../config/Database.js';
import NetworkUsage from '../../../models/NetworkUsageModel.js';
import { NETWORK_USAGE_ATTRIBUTES } from './QueryHelpers.js';
import { log } from '../../../lib/Logger.js';

/**
 * Get list of active network interfaces with optional filtering
 * @param {string|null} linkFilter - Optional interface name filter
 * @returns {Promise<Array>} Array of interface names
 */
export const getActiveInterfacesList = async (linkFilter = null) => {
  try {
    const whereClause = {};
    if (linkFilter) {
      whereClause.link = { [Op.like]: `%${linkFilter}%` };
    }

    const interfaces = await NetworkUsage.findAll({
      attributes: ['link'],
      where: whereClause,
      group: ['link'],
      raw: true,
      order: [['link', 'ASC']],
    });

    return interfaces.map(row => row.link);
  } catch (error) {
    log.database.error('Error getting active interfaces list', {
      error: error.message,
      linkFilter,
    });
    return [];
  }
};

/**
 * Get time-series sampled data using database window functions (NTILE)
 * @param {Array} interfaces - List of interface names to query
 * @param {string} since - Starting timestamp
 * @param {number} samplesPerInterface - Number of samples per interface
 * @returns {Promise<Array>} Time-sampled network usage data
 */
export const getTimeSeriesSampledData = async (interfaces, since, samplesPerInterface) => {
  const startTime = Date.now();

  try {
    // Handle empty interface list
    if (!interfaces || interfaces.length === 0) {
      return [];
    }

    const interfaceList = interfaces.map(i => `'${i.replace(/'/g, "''")}'`).join(',');

    // Simple and fast SQLite time sampling query using NTILE
    const query = `
      WITH sampled_data AS (
        SELECT 
          link, scan_timestamp, rx_mbps, tx_mbps, rx_bps, tx_bps,
          interface_speed_mbps, interface_class, time_delta_seconds,
          ipackets_delta, opackets_delta, rbytes_delta, obytes_delta,
          ierrors_delta, oerrors_delta, rx_utilization_pct, tx_utilization_pct,
          ipackets, rbytes, ierrors, opackets, obytes, oerrors,
          NTILE(:samplesPerInterface) OVER (
            PARTITION BY link 
            ORDER BY scan_timestamp ASC
          ) as time_bucket,
          ROW_NUMBER() OVER (
            PARTITION BY link 
            ORDER BY scan_timestamp ASC
          ) as row_num
        FROM network_usage 
        WHERE scan_timestamp >= :since
          AND link IN (${interfaceList})
      ),
      first_in_bucket AS (
        SELECT *
        FROM sampled_data
        WHERE row_num = (
          SELECT MIN(row_num) 
          FROM sampled_data s2 
          WHERE s2.link = sampled_data.link 
            AND s2.time_bucket = sampled_data.time_bucket
        )
      )
      SELECT 
        link, scan_timestamp, rx_mbps, tx_mbps, rx_bps, tx_bps,
        interface_speed_mbps, interface_class, time_delta_seconds,
        ipackets_delta, opackets_delta, rbytes_delta, obytes_delta,
        ierrors_delta, oerrors_delta, rx_utilization_pct, tx_utilization_pct,
        ipackets, rbytes, ierrors, opackets, obytes, oerrors
      FROM first_in_bucket
      ORDER BY link ASC, scan_timestamp ASC
    `;

    const results = await db.query(query, {
      replacements: {
        samplesPerInterface,
        since: new Date(since),
      },
      type: QueryTypes.SELECT,
    });

    log.monitoring.debug('Time-series sampling completed', {
      interfaces_count: interfaces.length,
      samples_per_interface: samplesPerInterface,
      total_results: results.length,
      query_time_ms: Date.now() - startTime,
      strategy: 'sql-ntile-optimized',
    });

    return results;
  } catch (error) {
    log.database.error('Error in time-series sampling query', {
      error: error.message,
      stack: error.stack,
      interfaces_count: interfaces.length,
      samples_per_interface: samplesPerInterface,
      query_time_ms: Date.now() - startTime,
    });
    throw error;
  }
};

/**
 * Fallback sampling method for databases without window function support
 * @param {Array} interfaces - List of interface names
 * @param {string} since - Starting timestamp
 * @param {number} samplesPerInterface - Number of samples per interface
 * @returns {Promise<Array>} Sampled data using Sequelize methods
 */
export const getFallbackSampledData = async (interfaces, since, samplesPerInterface) => {
  const startTime = Date.now();

  try {
    // Use parallel queries for each interface
    const interfaceQueries = interfaces.map(async interfaceName => {
      // Get total count for this interface
      const totalCount = await NetworkUsage.count({
        where: {
          link: interfaceName,
          scan_timestamp: { [Op.gte]: new Date(since) },
        },
      });

      if (totalCount === 0) {
        return [];
      }

      if (totalCount <= samplesPerInterface) {
        // Return all records if we have fewer than requested samples
        return NetworkUsage.findAll({
          where: {
            link: interfaceName,
            scan_timestamp: { [Op.gte]: new Date(since) },
          },
          attributes: NETWORK_USAGE_ATTRIBUTES,
          order: [['scan_timestamp', 'ASC']],
          raw: true,
        });
      }

      // Calculate sampling interval and get distributed samples
      const step = Math.floor(totalCount / samplesPerInterface);
      const sampleQueries = [];

      for (let i = 0; i < samplesPerInterface; i++) {
        sampleQueries.push(
          NetworkUsage.findOne({
            where: {
              link: interfaceName,
              scan_timestamp: { [Op.gte]: new Date(since) },
            },
            attributes: NETWORK_USAGE_ATTRIBUTES,
            order: [['scan_timestamp', 'ASC']],
            offset: i * step,
            raw: true,
          })
        );
      }

      const samples = await Promise.all(sampleQueries);
      return samples.filter(Boolean); // Remove any null results
    });

    const allResults = await Promise.all(interfaceQueries);
    const flatResults = allResults.flat();

    log.monitoring.debug('Fallback sampling completed', {
      interfaces_count: interfaces.length,
      samples_per_interface: samplesPerInterface,
      total_results: flatResults.length,
      query_time_ms: Date.now() - startTime,
      strategy: 'sequelize-fallback-sampling',
    });

    return flatResults.sort((a, b) => {
      if (a.link !== b.link) {
        return a.link.localeCompare(b.link);
      }
      return new Date(a.scan_timestamp) - new Date(b.scan_timestamp);
    });
  } catch (error) {
    log.database.error('Error in fallback sampling', {
      error: error.message,
      interfaces_count: interfaces.length,
      query_time_ms: Date.now() - startTime,
    });
    throw error;
  }
};

/**
 * Get count of interfaces and total records for metadata
 * @param {string|null} linkFilter - Optional interface filter
 * @param {string} since - Starting timestamp
 * @returns {Promise<Object>} Metadata about the dataset
 */
export const getDatasetMetadata = async (linkFilter, since) => {
  try {
    const whereClause = {
      scan_timestamp: { [Op.gte]: new Date(since) },
    };

    if (linkFilter) {
      whereClause.link = { [Op.like]: `%${linkFilter}%` };
    }

    const [totalRecords, interfaceList] = await Promise.all([
      NetworkUsage.count({ where: whereClause }),
      NetworkUsage.findAll({
        attributes: ['link'],
        where: whereClause,
        group: ['link'],
        order: [['link', 'ASC']],
        raw: true,
      }),
    ]);

    const interfaces = interfaceList.map(row => row.link);

    return {
      totalRecords,
      interfaceCount: interfaces.length,
      interfaces,
      averageRecordsPerInterface: Math.round(totalRecords / interfaces.length),
    };
  } catch (error) {
    log.database.error('Error getting dataset metadata', {
      error: error.message,
      linkFilter,
      since,
    });
    return {
      totalRecords: 0,
      interfaceCount: 0,
      interfaces: [],
      averageRecordsPerInterface: 0,
    };
  }
};

/**
 * Calculate time span metadata for results
 * @param {Array} sampledResults - Array of sampled records
 * @returns {Object|null} Time span metadata or null if insufficient data
 */
export const calculateOptimizedTimeSpan = sampledResults => {
  if (!sampledResults || sampledResults.length < 2) {
    return null;
  }

  const timestamps = sampledResults.map(row => new Date(row.scan_timestamp)).sort((a, b) => a - b);

  const [firstRecord] = timestamps;
  const lastRecord = timestamps[timestamps.length - 1];

  return {
    start: firstRecord.toISOString(),
    end: lastRecord.toISOString(),
    durationMinutes: Math.round((lastRecord - firstRecord) / (1000 * 60)),
    totalSamples: sampledResults.length,
    uniqueInterfaces: [...new Set(sampledResults.map(row => row.link))].length,
  };
};

/**
 * Build optimized sampling metadata
 * @param {Object} options - Sampling metadata options
 * @returns {Object} Sampling metadata object
 */
export const buildOptimizedSamplingMetadata = (options = {}) => {
  const {
    strategy = 'sql-ntile-sampling',
    interfaceCount = 0,
    samplesPerInterface = 0,
    totalSamples = 0,
    originalRecords = 0,
    queryTimeMs = 0,
    dataReduction = 0,
  } = options;

  return {
    applied: true,
    strategy,
    interfaceCount,
    samplesPerInterface,
    totalSamples,
    performance: {
      originalRecords,
      sampledRecords: totalSamples,
      dataReduction: `${dataReduction}%`,
      queryTimeMs,
      efficiency:
        originalRecords > 0 ? Math.round((originalRecords / totalSamples) * 100) / 100 : 1,
    },
  };
};

/**
 * Create optimized response object with timing and metadata
 * @param {Array} sampledData - Sampled network usage data
 * @param {Object} metadata - Dataset metadata
 * @param {number} samplesPerInterface - Requested samples per interface
 * @param {number} startTime - Query start time
 * @returns {Object} Complete response object
 */
export const createOptimizedResponse = (sampledData, metadata, samplesPerInterface, startTime) => {
  const queryTime = Date.now() - startTime;
  const timeSpan = calculateOptimizedTimeSpan(sampledData);

  // Calculate data reduction percentage
  const dataReduction =
    metadata.totalRecords > 0
      ? Math.round(((metadata.totalRecords - sampledData.length) / metadata.totalRecords) * 100)
      : 0;

  const activeInterfaces = sampledData.filter(row => row.rx_mbps > 0 || row.tx_mbps > 0).length;
  const interfaceList = [...new Set(sampledData.map(row => row.link))].sort();

  return {
    usage: sampledData,
    totalCount: sampledData.length,
    returnedCount: sampledData.length,
    sampling: buildOptimizedSamplingMetadata({
      strategy: 'sql-ntile-optimized',
      interfaceCount: metadata.interfaceCount,
      samplesPerInterface,
      totalSamples: sampledData.length,
      originalRecords: metadata.totalRecords,
      queryTimeMs: queryTime,
      dataReduction,
    }),
    metadata: {
      timeSpan,
      activeInterfacesCount: activeInterfaces,
      interfaceList,
      originalDataSize: metadata.totalRecords,
      compressionRatio:
        metadata.totalRecords > 0
          ? Math.round((metadata.totalRecords / sampledData.length) * 100) / 100
          : 1,
      averageRecordsPerInterface: metadata.averageRecordsPerInterface,
    },
    queryTime: `${queryTime}ms`,
  };
};
