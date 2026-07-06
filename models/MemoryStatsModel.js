import { Sequelize } from 'sequelize';
import db from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     MemoryStats:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         host:
 *           type: string
 *           description: Host where the memory stats are collected
 *           example: "hv-04"
 *         total_memory_bytes:
 *           type: integer
 *           format: int64
 *           description: Total physical memory in bytes
 *           example: 17179869184
 *         available_memory_bytes:
 *           type: integer
 *           format: int64
 *           description: Available memory in bytes (free + reclaimable)
 *           example: 8589934592
 *         used_memory_bytes:
 *           type: integer
 *           format: int64
 *           description: Used memory in bytes
 *           example: 8589934592
 *         free_memory_bytes:
 *           type: integer
 *           format: int64
 *           description: Free memory in bytes
 *           example: 4294967296
 *         buffers_bytes:
 *           type: integer
 *           format: int64
 *           description: Buffer memory in bytes
 *         cached_bytes:
 *           type: integer
 *           format: int64
 *           description: Cached memory in bytes
 *         memory_utilization_pct:
 *           type: number
 *           format: float
 *           description: Memory utilization percentage
 *           example: 50.0
 *         swap_total_bytes:
 *           type: integer
 *           format: int64
 *           description: Total swap space in bytes
 *           example: 4294967296
 *         swap_used_bytes:
 *           type: integer
 *           format: int64
 *           description: Used swap space in bytes
 *           example: 1073741824
 *         swap_free_bytes:
 *           type: integer
 *           format: int64
 *           description: Free swap space in bytes
 *           example: 3221225472
 *         swap_utilization_pct:
 *           type: number
 *           format: float
 *           description: Swap utilization percentage
 *           example: 25.0
 *         arc_size_bytes:
 *           type: integer
 *           format: int64
 *           description: ARC cache size in bytes
 *         arc_target_bytes:
 *           type: integer
 *           format: int64
 *           description: ARC target size in bytes
 *         kernel_memory_bytes:
 *           type: integer
 *           format: int64
 *           description: Kernel memory usage in bytes
 *         page_size_bytes:
 *           type: integer
 *           description: System page size in bytes
 *         pages_total:
 *           type: integer
 *           format: int64
 *           description: Total pages available
 *         pages_free:
 *           type: integer
 *           format: int64
 *           description: Free pages available
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
const MemoryStats = db.define(
  'memory_stats',
  {
    host: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Host where the memory stats are collected',
    },
    total_memory_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Total physical memory in bytes',
    },
    available_memory_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Available memory in bytes (free + reclaimable)',
    },
    used_memory_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Used memory in bytes',
    },
    free_memory_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Free memory in bytes',
    },
    buffers_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Buffer memory in bytes',
    },
    cached_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Cached memory in bytes',
    },
    memory_utilization_pct: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Memory utilization percentage',
    },
    swap_total_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Total swap space in bytes',
    },
    swap_used_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Used swap space in bytes',
    },
    swap_free_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Free swap space in bytes',
    },
    swap_utilization_pct: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Swap utilization percentage',
    },
    arc_size_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'ARC cache size in bytes',
    },
    arc_target_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'ARC target size in bytes',
    },
    kernel_memory_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Kernel memory usage in bytes',
    },
    page_size_bytes: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'System page size in bytes',
    },
    pages_total: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Total pages available',
    },
    pages_free: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Free pages available',
    },
    scan_timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When this data was collected',
    },
  },
  {
    freezeTableName: true,
    comment: 'System memory and swap usage statistics (collected every minute)',
    indexes: [
      {
        fields: ['host', 'scan_timestamp'],
      },
      {
        fields: ['scan_timestamp'],
      },
      {
        fields: ['memory_utilization_pct'],
      },
      {
        fields: ['swap_utilization_pct'],
      },
    ],
  }
);

export default MemoryStats;
