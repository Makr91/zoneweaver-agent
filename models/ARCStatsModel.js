import { Sequelize } from 'sequelize';
import { metricsStorageDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     ARCStats:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         host:
 *           type: string
 *           description: Host where the ARC stats are collected
 *           example: "hv-04"
 *         arc_size:
 *           type: integer
 *           format: int64
 *           description: Current ARC size in bytes
 *           example: 136699101592
 *         arc_target_size:
 *           type: integer
 *           format: int64
 *           description: Target ARC size in bytes (c)
 *           example: 136434647499
 *         arc_min_size:
 *           type: integer
 *           format: int64
 *           description: Minimum ARC size in bytes (c_min)
 *           example: 1073741824
 *         arc_max_size:
 *           type: integer
 *           format: int64
 *           description: Maximum ARC size in bytes (c_max)
 *           example: 204474830848
 *         arc_meta_used:
 *           type: integer
 *           format: int64
 *           description: ARC metadata size in bytes
 *           example: 2528202648
 *         arc_meta_limit:
 *           type: integer
 *           format: int64
 *           description: ARC metadata limit in bytes
 *           example: 51118707712
 *         mru_size:
 *           type: integer
 *           format: int64
 *           description: Most Recently Used cache size in bytes
 *           example: 134817696256
 *         mfu_size:
 *           type: integer
 *           format: int64
 *           description: Most Frequently Used cache size in bytes
 *           example: 554039296
 *         data_size:
 *           type: integer
 *           format: int64
 *           description: Data cache size in bytes
 *           example: 134170898944
 *         metadata_size:
 *           type: integer
 *           format: int64
 *           description: Metadata cache size in bytes
 *           example: 1213681152
 *         hits:
 *           type: integer
 *           format: int64
 *           description: Total cache hits
 *           example: 10229453041
 *         misses:
 *           type: integer
 *           format: int64
 *           description: Total cache misses
 *           example: 206754685
 *         demand_data_hits:
 *           type: integer
 *           format: int64
 *           description: Demand data hits
 *           example: 2957100695
 *         demand_data_misses:
 *           type: integer
 *           format: int64
 *           description: Demand data misses
 *           example: 79996255
 *         demand_metadata_hits:
 *           type: integer
 *           format: int64
 *           description: Demand metadata hits
 *           example: 7270439836
 *         demand_metadata_misses:
 *           type: integer
 *           format: int64
 *           description: Demand metadata misses
 *           example: 55370302
 *         prefetch_data_hits:
 *           type: integer
 *           format: int64
 *           description: Prefetch data hits
 *           example: 1886683
 *         prefetch_data_misses:
 *           type: integer
 *           format: int64
 *           description: Prefetch data misses
 *           example: 65496492
 *         mru_hits:
 *           type: integer
 *           format: int64
 *           description: Most Recently Used hits
 *           example: 2883540389
 *         mfu_hits:
 *           type: integer
 *           format: int64
 *           description: Most Frequently Used hits
 *           example: 7344012091
 *         mru_ghost_hits:
 *           type: integer
 *           format: int64
 *           description: MRU ghost list hits
 *           example: 3855979
 *         mfu_ghost_hits:
 *           type: integer
 *           format: int64
 *           description: MFU ghost list hits
 *           example: 90682075
 *         hit_ratio:
 *           type: number
 *           format: float
 *           description: Overall cache hit ratio percentage
 *           example: 98.02
 *         data_demand_efficiency:
 *           type: number
 *           format: float
 *           description: Data demand efficiency percentage
 *           example: 97.37
 *         data_prefetch_efficiency:
 *           type: number
 *           format: float
 *           description: Data prefetch efficiency percentage
 *           example: 2.80
 *         arc_p:
 *           type: integer
 *           format: int64
 *           description: ARC target size for MRU list
 *           example: 127903505327
 *         compressed_size:
 *           type: integer
 *           format: int64
 *           description: Compressed data size in bytes
 *           example: 129050594304
 *         uncompressed_size:
 *           type: integer
 *           format: int64
 *           description: Uncompressed data size in bytes
 *           example: 134791710720
 *         l2_size:
 *           type: integer
 *           format: int64
 *           description: L2ARC size in bytes
 *           example: 0
 *         l2_hits:
 *           type: integer
 *           format: int64
 *           description: L2ARC hits
 *           example: 0
 *         l2_misses:
 *           type: integer
 *           format: int64
 *           description: L2ARC misses
 *           example: 0
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
const ARCStats = db.define(
  'arc_stats',
  {
    host: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Host where the ARC stats are collected',
    },
    // Core ARC size metrics
    arc_size: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Current ARC size in bytes (size)',
    },
    arc_target_size: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Target ARC size in bytes (c)',
    },
    arc_min_size: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Minimum ARC size in bytes (c_min)',
    },
    arc_max_size: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Maximum ARC size in bytes (c_max)',
    },
    arc_meta_used: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'ARC metadata used in bytes (arc_meta_used)',
    },
    arc_meta_limit: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'ARC metadata limit in bytes (arc_meta_limit)',
    },

    // Cache breakdown
    mru_size: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Most Recently Used cache size in bytes (mru_size)',
    },
    mfu_size: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Most Frequently Used cache size in bytes (mfu_size)',
    },
    data_size: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Data cache size in bytes (data_size)',
    },
    metadata_size: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Metadata cache size in bytes (metadata_size)',
    },

    // Hit/miss statistics
    hits: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Total cache hits (hits)',
    },
    misses: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Total cache misses (misses)',
    },
    demand_data_hits: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Demand data hits (demand_data_hits)',
    },
    demand_data_misses: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Demand data misses (demand_data_misses)',
    },
    demand_metadata_hits: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Demand metadata hits (demand_metadata_hits)',
    },
    demand_metadata_misses: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Demand metadata misses (demand_metadata_misses)',
    },
    prefetch_data_hits: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Prefetch data hits (prefetch_data_hits)',
    },
    prefetch_data_misses: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Prefetch data misses (prefetch_data_misses)',
    },

    // MRU/MFU statistics
    mru_hits: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Most Recently Used hits (mru_hits)',
    },
    mfu_hits: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Most Frequently Used hits (mfu_hits)',
    },
    mru_ghost_hits: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'MRU ghost list hits (mru_ghost_hits)',
    },
    mfu_ghost_hits: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'MFU ghost list hits (mfu_ghost_hits)',
    },

    // Calculated efficiency metrics
    hit_ratio: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Overall cache hit ratio percentage',
    },
    data_demand_efficiency: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Data demand efficiency percentage',
    },
    data_prefetch_efficiency: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Data prefetch efficiency percentage',
    },

    // Additional ARC metrics
    arc_p: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'ARC target size for MRU list (p)',
    },
    compressed_size: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Compressed data size in bytes (compressed_size)',
    },
    uncompressed_size: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Uncompressed data size in bytes (uncompressed_size)',
    },

    // L2ARC statistics
    l2_size: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'L2ARC size in bytes (l2_size)',
    },
    l2_hits: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'L2ARC hits (l2_hits)',
    },
    l2_misses: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'L2ARC misses (l2_misses)',
    },

    scan_timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When this data was collected',
    },
  },
  {
    freezeTableName: true,
    comment: 'ZFS ARC (Adaptive Replacement Cache) statistics from kstat (collected every minute)',
    indexes: [
      {
        fields: ['host', 'scan_timestamp'],
      },
      {
        fields: ['scan_timestamp'],
      },
      {
        fields: ['hit_ratio'],
      },
    ],
  }
);

export default ARCStats;
