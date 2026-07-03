import { Sequelize } from 'sequelize';
import db from '../config/Database.js';
import { v4 as uuidv4 } from 'uuid';

const { DataTypes } = Sequelize;

/**
 * @fileoverview Terminal Session model for Zoneweaver Agent
 * @description Defines the database model for managing terminal sessions.
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     TerminalSession:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           description: Unique session identifier
 *           example: "a1b2c3d4-e5f6-7890-1234-567890abcdef"
 *         pid:
 *           type: integer
 *           description: Process ID of the node-pty process
 *           example: 12345
 *         status:
 *           type: string
 *           description: Current session status
 *           enum: [active, closed]
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
const TerminalSessions = db.define(
  'terminal_sessions',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: () => uuidv4(),
      primaryKey: true,
      comment: 'Unique session identifier',
    },
    terminal_cookie: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false,
      comment: 'Frontend-generated session identifier',
    },
    pid: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: 'Process ID of the node-pty process',
    },
    zone_name: {
      type: DataTypes.STRING,
      comment: 'Zone this terminal session is for',
    },
    status: {
      type: DataTypes.STRING,
      defaultValue: 'active',
      comment: 'Session status (active, closed)',
    },
    session_buffer: {
      type: DataTypes.TEXT,
      comment: 'Last 1000 lines of terminal output for reconnection',
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
      comment: 'Last time session had activity (input/output)',
    },
  },
  {
    freezeTableName: true,
    comment: 'Terminal sessions for browser-based terminal access',
  }
);

export default TerminalSessions;
