import { Sequelize } from 'sequelize';
import { metricsNetworkDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     IPAddress:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         host:
 *           type: string
 *           description: Host where the IP address is configured
 *           example: "hv-04"
 *         addrobj:
 *           type: string
 *           description: Address object name
 *           example: "vnich3_hv_04_0_6/v4"
 *         interface:
 *           type: string
 *           description: Network interface name
 *           example: "vnich3_hv_04_0_6"
 *         type:
 *           type: string
 *           description: Address type (static, dhcp, addrconf)
 *           example: "static"
 *         state:
 *           type: string
 *           description: Address state (ok, tentative, duplicate, etc.)
 *           example: "ok"
 *         addr:
 *           type: string
 *           description: IP address with prefix length
 *           example: "10.6.0.14/24"
 *         ip_address:
 *           type: string
 *           description: IP address without prefix
 *           example: "10.6.0.14"
 *         prefix_length:
 *           type: integer
 *           description: Network prefix length
 *           example: 24
 *         ip_version:
 *           type: string
 *           description: IP version (v4 or v6)
 *           example: "v4"
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
const IPAddresses = db.define(
  'ip_addresses',
  {
    host: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Host where the IP address is configured',
    },
    addrobj: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Address object name (e.g., vnich3_hv_04_0_6/v4)',
    },
    interface: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Network interface name',
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Address type (static, dhcp, addrconf)',
    },
    state: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Address state (ok, tentative, duplicate, etc.)',
    },
    addr: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'IP address with prefix length (e.g., 10.6.0.14/24)',
    },
    ip_address: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'IP address without prefix',
    },
    prefix_length: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Network prefix length',
    },
    ip_version: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'IP version (v4 or v6)',
    },
    scan_timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When this data was collected',
    },
  },
  {
    freezeTableName: true,
    comment: 'IP address assignments from ipadm show-addr',
    indexes: [
      {
        unique: true,
        fields: ['host', 'addrobj', 'scan_timestamp'],
      },
      {
        fields: ['host', 'scan_timestamp'],
      },
      {
        fields: ['interface'],
      },
      {
        fields: ['ip_address'],
      },
      {
        fields: ['ip_version'],
      },
      {
        fields: ['type'],
      },
      {
        fields: ['state'],
      },
      {
        fields: ['scan_timestamp'],
      },
    ],
  }
);

export default IPAddresses;
