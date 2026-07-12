import { Sequelize } from 'sequelize';
import { metricsSystemDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @fileoverview Per-zone usage metrics for Zoneweaver Agent
 * @description One row per zone per system-metrics tick. Sources (both verified
 * on host-1162): CPU from `zonestat -p -r summary`; memory from `bhyvectl
 * --get-stats` Resident memory for running bhyve zones (memory_cap does not
 * attribute guest RAM) with memory_cap rss as the native-zone/fallback value.
 *
 * Disk I/O deliberately does NOT live here: it is per-ZVOL, not per-zone (a
 * machine's boot and data volumes can sit on different arrays), and zone_vfs —
 * the only per-zone I/O kstat — misses bhyve's raw-zvol traffic entirely.
 * See ZvolIoStatsModel + ZvolIoCollector.
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     ZoneMetrics:
 *       type: object
 *       properties:
 *         host:
 *           type: string
 *         zone_name:
 *           type: string
 *           example: "8009--web-01.m4kr.net"
 *         cpu_used:
 *           type: number
 *           description: CPUs consumed over the sample interval (zonestat USED)
 *           example: 0.03
 *         cpu_pct:
 *           type: number
 *           description: Percent of TOTAL host CPU (zonestat %PART)
 *           example: 0.09
 *         rss_bytes:
 *           type: integer
 *           nullable: true
 *           description: Resident memory. Running bhyve zones report the hypervisor's real wired guest memory (bhyvectl Resident memory); native / stopped zones report memory_cap rss.
 *         swap_bytes:
 *           type: integer
 *           nullable: true
 *           description: Host-attributed swap reservation (memory_cap swap)
 *         scan_timestamp:
 *           type: string
 *           format: date-time
 */
const ZoneMetrics = db.define(
  'zone_metrics',
  {
    host: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Host where the zone runs',
    },
    zone_name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Zone name (global included for reference)',
    },
    cpu_used: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'CPUs consumed over the sample interval (zonestat USED)',
    },
    cpu_pct: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'Percent of total host CPU (zonestat %PART)',
    },
    rss_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Host-attributed resident memory (memory_cap rss)',
    },
    swap_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Host-attributed swap reservation (memory_cap swap)',
    },
    scan_timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When this sample was taken',
    },
  },
  {
    freezeTableName: true,
    comment: 'Per-zone CPU/memory time series (disk I/O lives in zvol_io_stats)',
    indexes: [
      {
        fields: ['zone_name', 'scan_timestamp'],
      },
    ],
  }
);

export default ZoneMetrics;
