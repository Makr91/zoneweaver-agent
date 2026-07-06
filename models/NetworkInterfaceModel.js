import { Sequelize } from 'sequelize';
import { metricsNetworkDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     NetworkInterface:
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
 *           description: Link name
 *           example: "vnice3_4001_0"
 *         class:
 *           type: string
 *           description: Interface class (phys, vnic, etc.)
 *           example: "vnic"
 *         over:
 *           type: string
 *           description: Physical interface this is over
 *           example: "ixgbe0"
 *         speed:
 *           type: integer
 *           description: Interface speed in Mbps
 *           example: 10000
 *         mtu:
 *           type: integer
 *           description: Maximum transmission unit
 *           example: 1500
 *         state:
 *           type: string
 *           description: Interface state (up, down)
 *           example: "up"
 *         macaddress:
 *           type: string
 *           description: MAC address
 *           example: "f2:2:0:1:0:1"
 *         macaddrtype:
 *           type: string
 *           description: MAC address type
 *           example: "fixed"
 *         vid:
 *           type: integer
 *           description: VLAN ID
 *           example: 0
 *         zone:
 *           type: string
 *           description: Zone assignment
 *           example: "4001--fw-os-n1.home.m4kr.net"
 *         media:
 *           type: string
 *           description: Media type
 *           example: "Ethernet"
 *         duplex:
 *           type: string
 *           description: Duplex setting
 *           example: "full"
 *         device:
 *           type: string
 *           description: Physical device name
 *           example: "ixgbe0"
 *         bridge:
 *           type: string
 *           description: Bridge assignment
 *           example: "--"
 *         pause:
 *           type: string
 *           description: Flow control pause setting
 *           example: "bi"
 *         auto:
 *           type: string
 *           description: Auto-negotiation setting
 *           example: "yes"
 *         ptype:
 *           type: string
 *           description: Port type
 *           example: "current"
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Record creation timestamp
 *         updated_at:
 *           type: string
 *           format: date-time
 *           description: Record last update timestamp
 */
const NetworkInterfaces = db.define(
  'network_interfaces',
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
    class: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Interface class (phys, vnic, etc.)',
    },
    over: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Physical interface this is layered over',
    },
    speed: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Interface speed in Mbps',
    },
    mtu: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Maximum transmission unit',
    },
    state: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Interface state (up, down, unknown)',
    },
    macaddress: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'MAC address',
    },
    macaddrtype: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'MAC address type (fixed, random, etc.)',
    },
    vid: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'VLAN ID',
    },
    zone: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Zone assignment',
    },
    media: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Physical media type',
    },
    duplex: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Duplex setting (full, half)',
    },
    device: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Physical device name',
    },
    bridge: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Bridge assignment',
    },
    pause: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Flow control pause setting',
    },
    auto: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Auto-negotiation setting',
    },
    ptype: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Port type',
    },
    scan_timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When this data was collected',
    },
    // Aggregate-specific fields
    policy: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Aggregate load balancing policy (L2, L3, L4, etc.)',
    },
    address_policy: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Aggregate address assignment policy (auto, fixed)',
    },
    lacp_activity: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'LACP activity mode (off, active, passive)',
    },
    lacp_timer: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'LACP timer setting (short, long)',
    },
    flags: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Aggregate operational flags',
    },
    ports_detail: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'JSON string containing detailed port information',
    },
    lacp_detail: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'JSON string containing LACP operational states',
    },
  },
  {
    freezeTableName: true,
    comment: 'Network interface configuration and status',
    indexes: [
      {
        unique: true,
        fields: ['host', 'link', 'scan_timestamp'],
      },
      {
        fields: ['host', 'scan_timestamp'],
      },
      {
        fields: ['state'],
      },
    ],
  }
);

export default NetworkInterfaces;
