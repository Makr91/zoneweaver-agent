import { Sequelize } from 'sequelize';
import { metricsStorageDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @fileoverview Per-machine, per-zvol disk I/O for Zoneweaver Agent
 * @description One row per (zone, zvol) per DTrace interval. This is the ONLY
 * source of per-VM disk I/O on this platform, established by probing host-1162:
 * OpenZFS objset kstats do not exist on illumos ZFS, no zvol block-device
 * kstat exists, and zone_vfs counts only the zone's own filesystem chatter —
 * it stays flat while a guest writes gigabytes (measured: 19KB "written" over
 * 8h on a live VM). bhyve issues pread/preadv/pwrite/pwritev against the raw
 * zvol, so the collector aggregates those syscalls' RETURN values (arg0 = bytes
 * actually transferred; on entry arg2 is the iovec COUNT, not a length) keyed by
 * zonename + the fd's pathname. Validated against a 849,346,560-byte guest dd:
 * captured 849,457,152 read / 853,300,224 written, attributed to the right zone
 * and the right zvol, with zero leakage into the neighbouring VM.
 *
 * Semantics: GUEST-REQUESTED I/O (what the VM asked the host for), not physical
 * pool I/O after ARC and compression — the correct number for "how much disk
 * I/O is this machine using".
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     ZvolIoStats:
 *       type: object
 *       properties:
 *         host:
 *           type: string
 *         zone_name:
 *           type: string
 *           example: "8009--web-01.m4kr.net"
 *         dataset:
 *           type: string
 *           description: The zvol dataset (the zone-rooted device path is normalized away)
 *           example: "Array-0/zones/8009--web-01.m4kr.net/boot"
 *         pool:
 *           type: string
 *           description: The pool/array the zvol lives on (first dataset component)
 *           example: "Array-0"
 *         device:
 *           type: string
 *           description: The zvol's leaf name — matches the machine's disk attr (bootdisk → boot, disk0/disk1 → their volume names)
 *           example: "boot"
 *         read_ops:
 *           type: integer
 *           description: Read operations during the interval
 *         read_bytes:
 *           type: integer
 *           description: Bytes read during the interval
 *         write_ops:
 *           type: integer
 *         write_bytes:
 *           type: integer
 *         read_bps:
 *           type: number
 *           description: read_bytes / interval_seconds
 *         write_bps:
 *           type: number
 *         read_iops:
 *           type: number
 *         write_iops:
 *           type: number
 *         interval_seconds:
 *           type: number
 *           description: Length of the aggregation interval these counts cover
 *         scan_timestamp:
 *           type: string
 *           format: date-time
 */
const ZvolIoStats = db.define(
  'zvol_io_stats',
  {
    host: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Host the machine runs on',
    },
    zone_name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Machine (zone) the I/O is attributed to',
    },
    dataset: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'zvol dataset path (pool/…/volume)',
    },
    pool: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Pool/array the zvol lives on',
    },
    device: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "zvol leaf name (the machine's disk attr value)",
    },
    read_ops: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      comment: 'Read operations in the interval',
    },
    read_bytes: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      comment: 'Bytes read in the interval',
    },
    write_ops: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      comment: 'Write operations in the interval',
    },
    write_bytes: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      comment: 'Bytes written in the interval',
    },
    read_bps: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'Read bytes/sec over the interval',
    },
    write_bps: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'Write bytes/sec over the interval',
    },
    read_iops: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'Read ops/sec over the interval',
    },
    write_iops: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'Write ops/sec over the interval',
    },
    interval_seconds: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'Length of the aggregation interval',
    },
    scan_timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'End of the aggregation interval',
    },
  },
  {
    freezeTableName: true,
    comment: 'Per-machine, per-zvol guest-requested disk I/O (DTrace-sourced)',
    indexes: [
      { fields: ['zone_name', 'scan_timestamp'] },
      { fields: ['dataset', 'scan_timestamp'] },
    ],
  }
);

export default ZvolIoStats;
