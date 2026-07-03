import { Sequelize } from 'sequelize';
import db from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @fileoverview VNC Session model for Zoneweaver Agent console management
 * @description Defines the database model for managing VNC console sessions
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     VncSession:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Unique session identifier
 *           example: 1
 *         zone_name:
 *           type: string
 *           description: Zone name for this VNC session
 *           example: "web-server-01"
 *         web_port:
 *           type: integer
 *           description: noVNC web interface port
 *           example: 6001
 *         host_ip:
 *           type: string
 *           description: Host IP address
 *           example: "127.0.0.1"
 *         requested_port:
 *           type: integer
 *           description: Static port from zone configuration (if specified)
 *           example: 9001
 *         console_host:
 *           type: string
 *           description: VNC bind address from zone configuration
 *           example: "0.0.0.0"
 *         port_source:
 *           type: string
 *           enum: [static, dynamic]
 *           description: Whether port was statically assigned or dynamically allocated
 *           example: "static"
 *         process_id:
 *           type: integer
 *           description: Process ID of the zadm webvnc process
 *           example: 12345
 *         status:
 *           type: string
 *           description: Current session status
 *           enum: [starting, active, stopped, error]
 *           example: "active"
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Session creation timestamp
 *         last_accessed:
 *           type: string
 *           format: date-time
 *           description: Last time session was accessed
 */

/**
 * VNC Session model for console management
 * @description Sequelize model representing active VNC console sessions
 * @type {import('sequelize').Model}
 */
const VncSessions = db.define(
  'vnc_sessions',
  {
    zone_name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      comment: 'Zone name - only one VNC session per zone',
    },
    web_port: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: 'Port number for noVNC web interface',
    },
    host_ip: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: '127.0.0.1',
      comment: 'Host IP address where VNC server is running',
    },
    requested_port: {
      type: DataTypes.INTEGER,
      allowNull: true,
      validate: {
        min: 1025,
        max: 65535,
      },
      comment: 'Static port from zone configuration (null for dynamic allocation)',
    },
    console_host: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: '0.0.0.0',
      comment: 'VNC bind address from zone configuration',
    },
    port_source: {
      type: DataTypes.ENUM('static', 'dynamic'),
      defaultValue: 'dynamic',
      comment: 'Whether port was statically assigned or dynamically allocated',
    },
    process_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Process ID of the zadm webvnc process',
    },
    status: {
      type: DataTypes.STRING,
      defaultValue: 'starting',
      comment: 'Session status (starting, active, stopped, error)',
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'Timestamp when session was created',
    },
    last_accessed: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'Timestamp when session was last accessed',
    },
  },
  {
    freezeTableName: true,
    comment: 'VNC console sessions for zone management',
  }
);

export default VncSessions;
