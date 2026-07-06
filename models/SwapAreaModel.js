import { Sequelize } from 'sequelize';
import { metricsSystemDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     SwapArea:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         host:
 *           type: string
 *           description: Host where the swap area is located
 *           example: "hv-04"
 *         swapfile:
 *           type: string
 *           description: Path to swap file or device
 *           example: "/dev/zvol/dsk/rpool/swap"
 *         dev:
 *           type: string
 *           description: Device identifier
 *           example: "85,1"
 *         swaplo:
 *           type: integer
 *           format: int64
 *           description: Starting block of swap area
 *           example: 16
 *         blocks:
 *           type: integer
 *           format: int64
 *           description: Size in blocks
 *           example: 4194288
 *         free:
 *           type: integer
 *           format: int64
 *           description: Free blocks
 *           example: 4194288
 *         size_bytes:
 *           type: integer
 *           format: int64
 *           description: Total size in bytes
 *           example: 2147483648
 *         used_bytes:
 *           type: integer
 *           format: int64
 *           description: Used space in bytes
 *           example: 0
 *         free_bytes:
 *           type: integer
 *           format: int64
 *           description: Free space in bytes
 *           example: 2147483648
 *         utilization_pct:
 *           type: number
 *           format: float
 *           description: Utilization percentage
 *           example: 0.0
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
const SwapArea = db.define(
  'swap_areas',
  {
    host: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Host where the swap area is located',
    },
    swapfile: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Path to swap file or device (e.g., /dev/zvol/dsk/rpool/swap)',
    },
    dev: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Device identifier (major,minor)',
    },
    swaplo: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Starting block of swap area',
    },
    blocks: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Size in blocks (512-byte blocks)',
    },
    free: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Free blocks available',
    },
    size_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Total swap area size in bytes',
    },
    used_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Used swap space in bytes',
    },
    free_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Free swap space in bytes',
    },
    utilization_pct: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Swap utilization percentage (used/total * 100)',
    },
    scan_timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When this data was collected',
    },
  },
  {
    freezeTableName: true,
    comment: 'Individual swap area information from swap -l (collected every 5 minutes)',
    indexes: [
      {
        unique: true,
        fields: ['host', 'swapfile'],
        name: 'unique_host_swapfile',
      },
      {
        fields: ['host', 'scan_timestamp'],
      },
      {
        fields: ['scan_timestamp'],
      },
      {
        fields: ['utilization_pct'],
      },
    ],
  }
);

export default SwapArea;
