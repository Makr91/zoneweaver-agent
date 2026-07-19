/**
 * @fileoverview Query Helper Utilities for Host Monitoring
 * @description Common query building, filtering, and pagination utilities
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { Op } from 'sequelize';

/**
 * Build standard pagination object
 * @param {number} limit - Records per page
 * @param {number} offset - Records to skip
 * @param {number} totalCount - Total record count
 * @returns {Object} Pagination metadata
 */
export const buildPagination = (limit, offset, totalCount) => ({
  limit: parseInt(limit),
  offset: parseInt(offset),
  hasMore: totalCount > parseInt(offset) + parseInt(limit),
});

/**
 * Build where clause for network interface filtering
 * @param {Object} filters - Filter parameters
 * @returns {Object} Sequelize where clause
 */
export const buildNetworkWhereClause = (filters = {}) => {
  const whereClause = {};

  if (filters.state) {
    whereClause.state = filters.state;
  }
  if (filters.link) {
    whereClause.link = { [Op.like]: `%${filters.link}%` };
  }
  if (filters.interface) {
    whereClause.interface = { [Op.like]: `%${filters.interface}%` };
  }
  if (filters.ip_version) {
    whereClause.ip_version = filters.ip_version;
  }
  if (filters.is_default !== undefined) {
    whereClause.is_default = filters.is_default === 'true';
  }
  if (filters.destination) {
    whereClause.destination = { [Op.like]: `%${filters.destination}%` };
  }
  if (filters.since) {
    whereClause.scan_timestamp = { [Op.gte]: new Date(filters.since) };
  }

  return whereClause;
};

/**
 * Build where clause for storage filtering
 * @param {Object} filters - Filter parameters
 * @returns {Object} Sequelize where clause
 */
export const buildStorageWhereClause = (filters = {}) => {
  const whereClause = {};

  if (filters.pool) {
    whereClause.pool = { [Op.like]: `%${filters.pool}%` };
  }
  if (filters.health) {
    whereClause.health = filters.health;
  }
  if (filters.type) {
    whereClause.type = filters.type;
  }
  if (filters.name) {
    whereClause.name = { [Op.like]: `%${filters.name}%` };
  }
  if (filters.device) {
    whereClause.device_name = { [Op.like]: `%${filters.device}%` };
  }
  if (filters.pool_type) {
    whereClause.pool_type = filters.pool_type;
  }
  if (filters.available !== undefined) {
    whereClause.is_available = filters.available === 'true';
  }
  if (filters.disk_type) {
    whereClause.disk_type = filters.disk_type;
  }
  if (filters.since) {
    whereClause.scan_timestamp = { [Op.gte]: new Date(filters.since) };
  }

  return whereClause;
};

/**
 * Build where clause for system metrics filtering
 * @param {Object} filters - Filter parameters
 * @returns {Object} Sequelize where clause
 */
export const buildSystemMetricsWhereClause = (filters = {}) => {
  const whereClause = {};

  if (filters.since) {
    whereClause.scan_timestamp = { [Op.gte]: new Date(filters.since) };
  }

  return whereClause;
};

/**
 * Standard network interface attributes for queries
 */
export const NETWORK_INTERFACE_ATTRIBUTES = [
  'id',
  'link',
  'state',
  'scan_timestamp',
  'class',
  'mtu',
  'over',
  'speed',
  'duplex',
  'zone',
];

/**
 * Standard network usage attributes for queries
 */
export const NETWORK_USAGE_ATTRIBUTES = [
  'link',
  'scan_timestamp',
  'rx_mbps',
  'tx_mbps',
  'rx_bps',
  'tx_bps',
  'rbytes',
  'obytes',
  'interface_speed_mbps',
  'interface_class',
  'time_delta_seconds',
  'ipackets_delta',
  'opackets_delta',
  'rbytes_delta',
  'obytes_delta',
  'ierrors_delta',
  'oerrors_delta',
  'ipackets',
];

/**
 * Standard IP address attributes for queries
 */
export const IP_ADDRESS_ATTRIBUTES = [
  'id',
  'interface',
  'ip_address',
  'ip_version',
  'state',
  'scan_timestamp',
  'addrobj',
  'type',
  'addr',
  'prefix_length',
];

/**
 * Standard route attributes for queries
 */
export const ROUTE_ATTRIBUTES = [
  'id',
  'destination',
  'gateway',
  'interface',
  'ip_version',
  'is_default',
  'flags',
  'scan_timestamp',
  'ref',
  'use',
  'destination_mask',
];

/**
 * Standard disk I/O attributes for queries
 */
export const DISK_IO_ATTRIBUTES = [
  'id',
  'device_name',
  'pool',
  'scan_timestamp',
  'read_ops',
  'write_ops',
  'read_bandwidth',
  'write_bandwidth',
  'read_bandwidth_bytes',
  'write_bandwidth_bytes',
  'read_ops_per_sec',
  'write_ops_per_sec',
  'alloc',
  'free',
];

/**
 * Standard pool I/O attributes for queries
 */
export const POOL_IO_ATTRIBUTES = [
  'id',
  'pool',
  'pool_type',
  'scan_timestamp',
  'read_ops',
  'write_ops',
  'read_bandwidth',
  'write_bandwidth',
  'read_bandwidth_bytes',
  'write_bandwidth_bytes',
  'total_wait_read',
  'total_wait_write',
  'disk_wait_read',
  'disk_wait_write',
  'syncq_wait_read',
  'syncq_wait_write',
  'asyncq_wait_read',
  'asyncq_wait_write',
];

/**
 * Standard ARC statistics attributes for queries
 */
export const ARC_STATS_ATTRIBUTES = [
  'id',
  'scan_timestamp',
  'arc_size',
  'arc_target_size',
  'arc_min_size',
  'arc_max_size',
  'arc_meta_used',
  'arc_meta_limit',
  'mru_size',
  'mfu_size',
  'data_size',
  'metadata_size',
  'hits',
  'misses',
  'demand_data_hits',
  'demand_data_misses',
  'hit_ratio',
  'data_demand_efficiency',
  'data_prefetch_efficiency',
  'l2_hits',
  'l2_misses',
  'l2_size',
];

/**
 * Standard CPU statistics attributes for queries
 */
export const CPU_STATS_ATTRIBUTES = [
  'id',
  'scan_timestamp',
  'cpu_utilization_pct',
  'load_avg_1min',
  'load_avg_5min',
  'load_avg_15min',
  'user_pct',
  'system_pct',
  'idle_pct',
  'iowait_pct',
  'io_delay_pct',
  'context_switches',
  'interrupts',
  'system_calls',
  'processes_running',
  'processes_blocked',
  'cpu_count',
  'page_faults',
  'page_ins',
  'page_outs',
];

/**
 * Standard memory statistics attributes for queries
 */
export const MEMORY_STATS_ATTRIBUTES = [
  'id',
  'scan_timestamp',
  'total_memory_bytes',
  'used_memory_bytes',
  'free_memory_bytes',
  'available_memory_bytes',
  'memory_utilization_pct',
  'swap_total_bytes',
  'swap_used_bytes',
  'swap_free_bytes',
  'swap_utilization_pct',
];
