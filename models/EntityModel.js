import { Sequelize } from 'sequelize';
import db from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @fileoverview Entity model for API key management in Zoneweaver Agent
 * @description Defines the database model for API key entities that can access the system
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Entity:
 *       type: object
 *       description: API key entity with metadata and usage tracking
 *       properties:
 *         id:
 *           type: integer
 *           description: Unique identifier for the entity
 *           example: 1
 *         name:
 *           type: string
 *           description: Human-readable name for the API key
 *           example: "Zoneweaver-Production"
 *         api_key_hash:
 *           type: string
 *           description: Bcrypt hash of the API key (never exposed in API responses)
 *           example: "$2b$12$..."
 *         description:
 *           type: string
 *           nullable: true
 *           description: Optional description of the API key purpose
 *           example: "API key for Zoneweaverfrontend"
 *         role:
 *           type: string
 *           enum: [admin, operator, viewer]
 *           description: |
 *             Authorization role (Agent API v1 direct-mode role model).
 *             viewer = read-only; operator = all operations incl. consoles;
 *             admin = everything incl. key management, settings, host power,
 *             system account management.
 *           example: "admin"
 *         is_active:
 *           type: boolean
 *           description: Whether the API key is active and can be used
 *           example: true
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Entity creation timestamp
 *           example: "2025-06-08T17:18:00.324Z"
 *         last_used:
 *           type: string
 *           format: date-time
 *           description: Last time the API key was used
 *           example: "2025-06-08T17:19:19.921Z"
 */

/**
 * Entity model for API key management
 * @description Sequelize model representing API key entities in the database
 * @type {import('sequelize').Model}
 */
const Entities = db.define(
  'entities',
  {
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Human-readable name for the API key entity',
    },
    api_key_hash: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Bcrypt hash of the API key for secure storage',
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Optional description of the API key purpose',
    },
    role: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'admin',
      comment: 'Authorization role for this API key: admin | operator | viewer (Agent API v1)',
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      comment: 'Whether the API key is active and can be used for authentication',
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'Timestamp when the entity was created',
    },
    last_used: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'Timestamp when the API key was last used for authentication',
    },
  },
  {
    freezeTableName: true,
    comment: 'API key entities for authentication and access control',
  }
);

export default Entities;
