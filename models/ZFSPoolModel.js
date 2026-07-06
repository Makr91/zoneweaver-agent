import { Sequelize } from 'sequelize';
import { metricsStorageDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     ZFSPool:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         host:
 *           type: string
 *           description: Host where the pool is located
 *           example: "hv-04"
 *         pool:
 *           type: string
 *           description: Pool name
 *           example: "Array-0"
 *         alloc:
 *           type: string
 *           description: Allocated space with units
 *           example: "6.05G"
 *         free:
 *           type: string
 *           description: Free space with units
 *           example: "61.9G"
 *         alloc_bytes:
 *           type: string
 *           description: Allocated space in bytes (for calculations)
 *           example: "6497058816"
 *         free_bytes:
 *           type: string
 *           description: Free space in bytes (for calculations)
 *           example: "66457346048"
 *         capacity:
 *           type: number
 *           description: Capacity usage percentage
 *           example: 8.9
 *         read_ops:
 *           type: string
 *           description: Read operations count
 *           example: "4"
 *         write_ops:
 *           type: string
 *           description: Write operations count
 *           example: "1"
 *         read_bandwidth:
 *           type: string
 *           description: Read bandwidth with units
 *           example: "296K"
 *         write_bandwidth:
 *           type: string
 *           description: Write bandwidth with units
 *           example: "86.1K"
 *         health:
 *           type: string
 *           description: Pool health status
 *           example: "ONLINE"
 *         status:
 *           type: string
 *           description: Pool status
 *           example: "ok"
 *         errors:
 *           type: string
 *           description: Error information
 *           example: "No known data errors"
 *         scan_type:
 *           type: string
 *           description: Type of scan being performed
 *           example: "iostat"
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
const ZFSPools = db.define(
  'zfs_pools',
  {
    host: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Host where the pool is located',
    },
    pool: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'ZFS pool name',
    },
    alloc: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Allocated space with units (e.g., "6.05G")',
    },
    free: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Free space with units (e.g., "61.9G")',
    },
    alloc_bytes: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Allocated space in bytes (for calculations)',
    },
    free_bytes: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Free space in bytes (for calculations)',
    },
    capacity: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Capacity usage percentage',
    },
    read_ops: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Read operations count',
    },
    write_ops: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Write operations count',
    },
    read_bandwidth: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Read bandwidth with units',
    },
    write_bandwidth: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Write bandwidth with units',
    },
    health: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Pool health status (ONLINE, DEGRADED, FAULTED, etc.)',
    },
    status: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Pool status information',
    },
    errors: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Error information or descriptions',
    },
    scan_type: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'iostat',
      comment: 'Type of scan (iostat, status, etc.)',
    },
    scan_timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When this data was collected',
    },
  },
  {
    freezeTableName: true,
    comment: 'ZFS pool status and I/O statistics (collected every 5 minutes)',
    indexes: [
      {
        fields: ['host', 'pool', 'scan_timestamp'],
      },
      {
        fields: ['host', 'scan_timestamp'],
      },
      {
        fields: ['scan_timestamp'],
      },
      {
        fields: ['pool', 'scan_timestamp'],
      },
      {
        fields: ['health'],
      },
      {
        fields: ['scan_type'],
      },
    ],
  }
);

export default ZFSPools;
