import { Sequelize } from 'sequelize';
import { metricsStorageDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     PoolIOStats:
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
 *         pool_type:
 *           type: string
 *           description: Pool RAID configuration type
 *           example: "raidz2"
 *         alloc:
 *           type: string
 *           description: Allocated space with units
 *           example: "234G"
 *         free:
 *           type: string
 *           description: Free space with units
 *           example: "314G"
 *         read_ops:
 *           type: string
 *           description: Read operations count
 *           example: "3"
 *         write_ops:
 *           type: string
 *           description: Write operations count
 *           example: "109"
 *         read_bandwidth:
 *           type: string
 *           description: Read bandwidth with units
 *           example: "19.9K"
 *         write_bandwidth:
 *           type: string
 *           description: Write bandwidth with units
 *           example: "2.62M"
 *         read_bandwidth_bytes:
 *           type: string
 *           description: Read bandwidth in bytes per second
 *           example: "20412"
 *         write_bandwidth_bytes:
 *           type: string
 *           description: Write bandwidth in bytes per second
 *           example: "2747805"
 *         total_wait_read:
 *           type: string
 *           description: Total wait time for read operations
 *           example: "3ms"
 *         total_wait_write:
 *           type: string
 *           description: Total wait time for write operations
 *           example: "4ms"
 *         disk_wait_read:
 *           type: string
 *           description: Disk wait time for read operations
 *           example: "2ms"
 *         disk_wait_write:
 *           type: string
 *           description: Disk wait time for write operations
 *           example: "1ms"
 *         syncq_wait_read:
 *           type: string
 *           description: Synchronous queue wait time for reads
 *           example: "243us"
 *         syncq_wait_write:
 *           type: string
 *           description: Synchronous queue wait time for writes
 *           example: "5ms"
 *         asyncq_wait_read:
 *           type: string
 *           description: Asynchronous queue wait time for reads
 *           example: "2ms"
 *         asyncq_wait_write:
 *           type: string
 *           description: Asynchronous queue wait time for writes
 *           example: "3ms"
 *         scrub_wait:
 *           type: string
 *           description: Scrub operation wait time
 *           example: "53ms"
 *         trim_wait:
 *           type: string
 *           description: Trim operation wait time
 *           example: "-"
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
const PoolIOStats = db.define(
  'pool_io_stats',
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
    pool_type: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Pool RAID configuration (raidz1, raidz2, mirror, etc.)',
    },
    alloc: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Allocated space with units (e.g., "234G")',
    },
    free: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Free space with units (e.g., "314G")',
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
    read_bandwidth_bytes: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Read bandwidth in bytes per second',
    },
    write_bandwidth_bytes: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Write bandwidth in bytes per second',
    },
    total_wait_read: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Total wait time for read operations (e.g., "3ms")',
    },
    total_wait_write: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Total wait time for write operations (e.g., "4ms")',
    },
    disk_wait_read: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Disk wait time for read operations (e.g., "2ms")',
    },
    disk_wait_write: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Disk wait time for write operations (e.g., "1ms")',
    },
    syncq_wait_read: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Synchronous queue wait time for reads (e.g., "243us")',
    },
    syncq_wait_write: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Synchronous queue wait time for writes (e.g., "5ms")',
    },
    asyncq_wait_read: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Asynchronous queue wait time for reads (e.g., "2ms")',
    },
    asyncq_wait_write: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Asynchronous queue wait time for writes (e.g., "3ms")',
    },
    scrub_wait: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Scrub operation wait time (e.g., "53ms")',
    },
    trim_wait: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Trim operation wait time (e.g., "-")',
    },
    scan_timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When this data was collected',
    },
  },
  {
    freezeTableName: true,
    comment:
      'ZFS pool I/O performance statistics with latency metrics (collected every 10 seconds)',
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
    ],
  }
);

export default PoolIOStats;
