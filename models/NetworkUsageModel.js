import { Sequelize } from 'sequelize';
import { metricsNetworkDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     NetworkUsage:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         host:
 *           type: string
 *           description: Host where the interface is located
 *           example: "hv-04"
 *         link:
 *           type: string
 *           description: Link/interface name
 *           example: "vnici3_4001_0"
 *         ipackets:
 *           type: string
 *           description: Total input packets (cumulative counter)
 *           example: "9144863843"
 *         rbytes:
 *           type: string
 *           description: Total received bytes (cumulative counter)
 *           example: "318804616907"
 *         ierrors:
 *           type: string
 *           description: Total input errors (cumulative counter)
 *           example: "0"
 *         opackets:
 *           type: string
 *           description: Total output packets (cumulative counter)
 *           example: "3087950516"
 *         obytes:
 *           type: string
 *           description: Total output bytes (cumulative counter)
 *           example: "221205539222"
 *         oerrors:
 *           type: string
 *           description: Total output errors (cumulative counter)
 *           example: "0"
 *         rx_bps:
 *           type: integer
 *           description: Calculated receive bandwidth in bytes per second
 *           example: 1048576
 *         tx_bps:
 *           type: integer
 *           description: Calculated transmit bandwidth in bytes per second
 *           example: 524288
 *         rx_mbps:
 *           type: number
 *           description: Calculated receive bandwidth in Mbps
 *           example: 8.39
 *         tx_mbps:
 *           type: number
 *           description: Calculated transmit bandwidth in Mbps
 *           example: 4.19
 *         rx_utilization_pct:
 *           type: number
 *           description: Receive bandwidth utilization percentage
 *           example: 0.84
 *         tx_utilization_pct:
 *           type: number
 *           description: Transmit bandwidth utilization percentage
 *           example: 0.42
 *         interface_speed_mbps:
 *           type: integer
 *           description: Interface speed in Mbps
 *           example: 1000
 *         interface_class:
 *           type: string
 *           description: Interface class (vnic, phys, etc.)
 *           example: "vnic"
 *         time_delta_seconds:
 *           type: number
 *           description: Time difference from previous measurement in seconds
 *           example: 60.5
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
const NetworkUsage = db.define(
  'network_usage',
  {
    host: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Host where the interface is located',
    },
    link: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Link/interface name',
    },
    // Raw counters from dladm show-link -s
    ipackets: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Total input packets (cumulative counter)',
    },
    rbytes: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Total received bytes (cumulative counter)',
    },
    ierrors: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Total input errors (cumulative counter)',
    },
    opackets: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Total output packets (cumulative counter)',
    },
    obytes: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Total output bytes (cumulative counter)',
    },
    oerrors: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Total output errors (cumulative counter)',
    },

    // Delta values (calculated from previous sample)
    ipackets_delta: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Input packets since previous sample',
    },
    rbytes_delta: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Received bytes since previous sample',
    },
    ierrors_delta: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Input errors since previous sample',
    },
    opackets_delta: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Output packets since previous sample',
    },
    obytes_delta: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Output bytes since previous sample',
    },
    oerrors_delta: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Output errors since previous sample',
    },

    // Calculated bandwidth values
    rx_bps: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Calculated receive bandwidth in bytes per second',
    },
    tx_bps: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Calculated transmit bandwidth in bytes per second',
    },
    rx_mbps: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      comment: 'Calculated receive bandwidth in Mbps',
    },
    tx_mbps: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      comment: 'Calculated transmit bandwidth in Mbps',
    },

    // Utilization percentages
    rx_utilization_pct: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Receive bandwidth utilization percentage (0-100)',
    },
    tx_utilization_pct: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Transmit bandwidth utilization percentage (0-100)',
    },

    // Interface information
    interface_speed_mbps: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Interface speed in Mbps',
    },
    interface_class: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Interface class (vnic, phys, etc.)',
    },

    // Metadata
    time_delta_seconds: {
      type: DataTypes.DECIMAL(10, 3),
      allowNull: true,
      comment: 'Time difference from previous measurement in seconds',
    },

    // Legacy fields for backwards compatibility
    duration: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Duration of the measurement period in seconds (legacy)',
    },
    bandwidth: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Calculated bandwidth with units (legacy)',
    },
    bandwidth_mbps: {
      type: DataTypes.DECIMAL(10, 3),
      allowNull: true,
      comment: 'Bandwidth value in Mbps (legacy)',
    },

    scan_timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When this data was collected',
    },
  },
  {
    freezeTableName: true,
    comment: 'Network interface usage accounting data from dladm show-usage',
    indexes: [
      {
        fields: ['host', 'link', 'scan_timestamp'],
      },
      {
        fields: ['host', 'scan_timestamp'],
      },
      {
        fields: ['scan_timestamp'],
      },
      {
        fields: ['link', 'scan_timestamp'],
      },
      {
        fields: ['bandwidth_mbps'],
      },
    ],
  }
);

export default NetworkUsage;
