import { Sequelize } from 'sequelize';
import { metricsNetworkDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     Route:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         host:
 *           type: string
 *           description: Host where the route is configured
 *           example: "hv-04"
 *         destination:
 *           type: string
 *           description: Destination network or host
 *           example: "10.6.0.0"
 *         gateway:
 *           type: string
 *           description: Gateway IP address
 *           example: "10.6.0.1"
 *         flags:
 *           type: string
 *           description: Route flags (UG, UH, U, etc.)
 *           example: "UG"
 *         ref:
 *           type: integer
 *           description: Reference count
 *           example: 9
 *         use:
 *           type: string
 *           description: Use count (string for large numbers)
 *           example: "2248815705"
 *         interface:
 *           type: string
 *           description: Network interface
 *           example: "vnich3_hv_04_0_6"
 *         ip_version:
 *           type: string
 *           description: IP version (v4 or v6)
 *           example: "v4"
 *         destination_mask:
 *           type: string
 *           description: Destination with mask (for IPv6)
 *           example: "::1"
 *         is_default:
 *           type: boolean
 *           description: Whether this is a default route
 *           example: true
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
const Routes = db.define(
  'routes',
  {
    host: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Host where the route is configured',
    },
    destination: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Destination network or host',
    },
    gateway: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Gateway IP address',
    },
    flags: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Route flags (UG, UH, U, etc.)',
    },
    ref: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Reference count',
    },
    use: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Use count (string for large numbers)',
    },
    interface: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Network interface',
    },
    ip_version: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'IP version (v4 or v6)',
    },
    destination_mask: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Destination with mask (for IPv6 routes)',
    },
    is_default: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Whether this is a default route',
    },
    scan_timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When this data was collected',
    },
  },
  {
    freezeTableName: true,
    comment: 'Routing table entries from netstat -rn',
    indexes: [
      {
        unique: true,
        fields: ['host', 'destination', 'gateway', 'interface', 'ip_version', 'scan_timestamp'],
      },
      {
        fields: ['host', 'scan_timestamp'],
      },
      {
        fields: ['interface'],
      },
      {
        fields: ['ip_version'],
      },
      {
        fields: ['is_default'],
      },
      {
        fields: ['destination'],
      },
      {
        fields: ['gateway'],
      },
      {
        fields: ['scan_timestamp'],
      },
    ],
  }
);

export default Routes;
