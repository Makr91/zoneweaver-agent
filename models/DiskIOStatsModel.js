import { Sequelize } from 'sequelize';
import { metricsStorageDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     DiskIOStats:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         host:
 *           type: string
 *           description: Host where the disk is located
 *           example: "hv-04"
 *         pool:
 *           type: string
 *           description: Pool name this disk belongs to
 *           example: "Array-0"
 *         device_name:
 *           type: string
 *           description: Device name (e.g., c0t5F8DB4C192001CC8d0s1)
 *           example: "c0t5F8DB4C192001CC8d0s1"
 *         alloc:
 *           type: string
 *           description: Allocated space on device
 *           example: "-"
 *         free:
 *           type: string
 *           description: Free space on device
 *           example: "-"
 *         read_ops:
 *           type: string
 *           description: Read operations count
 *           example: "0"
 *         write_ops:
 *           type: string
 *           description: Write operations count
 *           example: "26"
 *         read_bandwidth:
 *           type: string
 *           description: Read bandwidth with units
 *           example: "4.83K"
 *         write_bandwidth:
 *           type: string
 *           description: Write bandwidth with units
 *           example: "675K"
 *         read_ops_per_sec:
 *           type: number
 *           description: Read operations per second (calculated)
 *           example: 0.0
 *         write_ops_per_sec:
 *           type: number
 *           description: Write operations per second (calculated)
 *           example: 2.6
 *         read_bandwidth_bytes:
 *           type: integer
 *           format: int64
 *           description: Read bandwidth in bytes/sec
 *           example: 4947
 *         write_bandwidth_bytes:
 *           type: integer
 *           format: int64
 *           description: Write bandwidth in bytes/sec
 *           example: 691200
 *         scan_timestamp:
 *           type: string
 *           format: date-time
 *           description: When this data was collected
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Record creation timestamp
 *         updated_at:
 *           type: string
 *           format: date-time
 *           description: Record last update timestamp
 */
const DiskIOStats = db.define(
  'disk_io_stats',
  {
    host: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Host where the disk is located',
    },
    pool: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Pool name this disk belongs to',
    },
    device_name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Physical device name (e.g., c0t5F8DB4C192001CC8d0s1)',
    },
    alloc: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Allocated space on device with units',
    },
    free: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Free space on device with units',
    },
    read_ops: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Read operations count (cumulative)',
    },
    write_ops: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Write operations count (cumulative)',
    },
    read_bandwidth: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Read bandwidth with units (e.g., "4.83K")',
    },
    write_bandwidth: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Write bandwidth with units (e.g., "675K")',
    },
    read_ops_per_sec: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      comment: 'Read operations per second (calculated from delta)',
    },
    write_ops_per_sec: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      comment: 'Write operations per second (calculated from delta)',
    },
    read_bandwidth_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Read bandwidth in bytes per second',
    },
    write_bandwidth_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Write bandwidth in bytes per second',
    },
    scan_timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When this data was collected',
    },
  },
  {
    freezeTableName: true,
    comment: 'Per-disk I/O statistics from zpool iostat -Hv (collected every 10 seconds)',
    indexes: [
      {
        fields: ['host', 'device_name', 'scan_timestamp'],
      },
      {
        fields: ['host', 'pool', 'scan_timestamp'],
      },
      {
        fields: ['scan_timestamp'],
      },
      {
        fields: ['pool', 'scan_timestamp'],
      },
      {
        fields: ['device_name'],
      },
    ],
  }
);

export default DiskIOStats;
