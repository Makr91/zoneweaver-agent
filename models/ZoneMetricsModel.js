import { Sequelize } from 'sequelize';
import { metricsSystemDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @fileoverview Per-zone usage metrics for Zoneweaver Agent
 * @description One row per zone per system-metrics tick. Sources (all verified
 * on host-1162): CPU from `zonestat -p -r summary`; memory from `bhyvectl
 * --get-stats` Resident memory for running bhyve zones (memory_cap does not
 * attribute guest RAM) with memory_cap rss as the native-zone/fallback value;
 * I/O from the zone_vfs kstats. Remaining platform caveat: zone_vfs sees
 * FILESYSTEM ops only (zvol block traffic bypasses VFS, so bhyve DISK I/O is
 * not per-zone-attributable on this platform).
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
 *         vfs_nread_bytes:
 *           type: integer
 *           nullable: true
 *           description: Cumulative bytes read through VFS (filesystem ops — zvol block traffic excluded)
 *         vfs_nwritten_bytes:
 *           type: integer
 *           nullable: true
 *         vfs_reads:
 *           type: integer
 *           nullable: true
 *           description: Cumulative VFS read ops
 *         vfs_writes:
 *           type: integer
 *           nullable: true
 *         vfs_read_bps:
 *           type: number
 *           nullable: true
 *           description: Bytes/sec read since the previous scan (null on the first sample after agent start)
 *         vfs_write_bps:
 *           type: number
 *           nullable: true
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
    vfs_nread_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Cumulative VFS bytes read (zone_vfs nread)',
    },
    vfs_nwritten_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Cumulative VFS bytes written (zone_vfs nwritten)',
    },
    vfs_reads: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Cumulative VFS read ops (zone_vfs reads)',
    },
    vfs_writes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Cumulative VFS write ops (zone_vfs writes)',
    },
    vfs_read_bps: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'VFS read bytes/sec since the previous scan',
    },
    vfs_write_bps: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'VFS write bytes/sec since the previous scan',
    },
    scan_timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When this sample was taken',
    },
  },
  {
    freezeTableName: true,
    comment: 'Per-zone CPU/memory/VFS-I/O time series',
    indexes: [
      {
        fields: ['zone_name', 'scan_timestamp'],
      },
    ],
  }
);

export default ZoneMetrics;
