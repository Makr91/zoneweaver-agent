import { Sequelize } from 'sequelize';
import db from '../config/Database.js';
import { v4 as uuidv4 } from 'uuid';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     SSHSession:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           description: Unique session identifier
 *           example: "a1b2c3d4-e5f6-7890-1234-567890abcdef"
 *         machine_name:
 *           type: string
 *           description: Machine name for this SSH session
 *           example: "web-server-01"
 *         status:
 *           type: string
 *           description: Current session status
 *           enum: [connecting, active, closed, failed]
 *           example: "active"
 *         ssh_host:
 *           type: string
 *           description: SSH target host/IP address
 *           example: "10.190.190.10"
 *         ssh_port:
 *           type: integer
 *           description: SSH target port
 *           example: 22
 *         ssh_username:
 *           type: string
 *           description: SSH username
 *           example: "startcloud"
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Session creation timestamp
 *         last_accessed:
 *           type: string
 *           format: date-time
 *           description: Last time session was accessed
 */
const SSHSessions = db.define(
  'ssh_sessions',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: () => uuidv4(),
      primaryKey: true,
      comment: 'Unique session identifier',
    },
    zone_name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Zone name for this SSH session',
    },
    status: {
      type: DataTypes.STRING,
      defaultValue: 'connecting',
      comment: 'Session status (connecting, active, closed, failed)',
    },
    ssh_host: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'SSH target host/IP address',
    },
    ssh_port: {
      type: DataTypes.INTEGER,
      defaultValue: 22,
      comment: 'SSH target port',
    },
    ssh_username: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'SSH username used for connection',
    },
    session_buffer: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Last 1000 lines of terminal output for reconnection context',
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
    last_activity: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'Timestamp of last activity (input/output)',
    },
  },
  {
    freezeTableName: true,
    comment: 'SSH terminal sessions for browser-based SSH access to zones',
  }
);

// Agent API v1 wire vocabulary (architecture O1): session rows serialize with
// machine_name; the zone_name attribute/column stays internal (OmniOS domain naming).
SSHSessions.prototype.toJSON = function toJSON() {
  const { zone_name: machineName, ...values } = this.get({ plain: true });
  return { ...values, machine_name: machineName };
};

export default SSHSessions;
