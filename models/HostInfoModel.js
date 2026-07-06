import { Sequelize } from 'sequelize';
import { metricsSystemDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     HostInfo:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         host:
 *           type: string
 *           description: Host identifier/name
 *           example: "hv-04"
 *         hostname:
 *           type: string
 *           description: System hostname
 *           example: "hv-04.home.m4kr.net"
 *         platform:
 *           type: string
 *           description: Operating system platform
 *           example: "sunos"
 *         release:
 *           type: string
 *           description: OS release version
 *           example: "5.11"
 *         arch:
 *           type: string
 *           description: System architecture
 *           example: "x64"
 *         uptime:
 *           type: number
 *           description: System uptime in seconds
 *           example: 86400
 *         network_acct_enabled:
 *           type: boolean
 *           description: Whether network accounting is enabled
 *           example: true
 *         network_acct_file:
 *           type: string
 *           description: Network accounting log file path
 *           example: "/var/log/net.log"
 *         last_network_scan:
 *           type: string
 *           format: date-time
 *           description: Last network interface scan timestamp
 *         last_network_stats_scan:
 *           type: string
 *           format: date-time
 *           description: Last network statistics scan timestamp
 *         last_network_usage_scan:
 *           type: string
 *           format: date-time
 *           description: Last network usage scan timestamp
 *         last_storage_scan:
 *           type: string
 *           format: date-time
 *           description: Last storage/ZFS scan timestamp
 *         network_scan_errors:
 *           type: integer
 *           description: Count of consecutive network scan errors
 *           example: 0
 *         storage_scan_errors:
 *           type: integer
 *           description: Count of consecutive storage scan errors
 *           example: 0
 *         last_error_message:
 *           type: string
 *           description: Last error message encountered
 *           example: null
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Record creation timestamp
 *         updated_at:
 *           type: string
 *           format: date-time
 *           description: Record last update timestamp
 */
const HostInfo = db.define(
  'host_info',
  {
    host: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      comment: 'Host identifier/name',
    },
    hostname: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'System hostname from os.hostname()',
    },
    platform: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Operating system platform',
    },
    release: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'OS release version',
    },
    arch: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'System architecture',
    },
    uptime: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'System uptime in seconds',
    },
    network_acct_enabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Whether network accounting is enabled (acctadm net)',
    },
    network_acct_file: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Network accounting log file path',
    },
    last_network_scan: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Last network interface configuration scan timestamp',
    },
    last_network_stats_scan: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Last network statistics scan timestamp',
    },
    last_network_usage_scan: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Last network usage accounting scan timestamp',
    },
    last_storage_scan: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Last storage/ZFS scan timestamp',
    },
    last_cpu_scan: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Last CPU statistics scan timestamp',
    },
    last_memory_scan: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Last memory statistics scan timestamp',
    },
    cpu_count: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Number of CPU cores detected',
    },
    total_memory_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Total physical memory in bytes',
    },
    network_scan_errors: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: 'Count of consecutive network scan errors',
    },
    storage_scan_errors: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: 'Count of consecutive storage scan errors',
    },
    last_error_message: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Last error message encountered during scans',
    },
  },
  {
    freezeTableName: true,
    comment: 'Host information and scan status tracking',
    indexes: [
      {
        unique: true,
        fields: ['host'],
      },
      {
        fields: ['last_network_scan'],
      },
      {
        fields: ['last_storage_scan'],
      },
      {
        fields: ['network_scan_errors'],
      },
      {
        fields: ['storage_scan_errors'],
      },
    ],
  }
);

export default HostInfo;
