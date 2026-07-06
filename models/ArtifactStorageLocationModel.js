import { Sequelize } from 'sequelize';
import { coreDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @fileoverview Artifact Storage Location model for Zoneweaver Agent
 * @description Defines the database model for artifact storage path configuration
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     ArtifactStorageLocation:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           description: Unique storage location identifier
 *           example: "123e4567-e89b-12d3-a456-426614174000"
 *         name:
 *           type: string
 *           description: Display name for the storage location
 *           example: "Primary ISO Storage"
 *         path:
 *           type: string
 *           description: Filesystem path for storage
 *           example: "/data/isos"
 *         type:
 *           type: string
 *           description: Type of artifacts stored (iso, image, or provisioning)
 *           enum: [iso, image, provisioning]
 *           example: "iso"
 *         enabled:
 *           type: boolean
 *           description: Whether this storage location is active
 *           example: true
 *         config_hash:
 *           type: string
 *           description: Hash of configuration for change detection
 *         file_count:
 *           type: integer
 *           description: Number of artifacts in this location
 *           example: 42
 *         total_size:
 *           type: integer
 *           format: int64
 *           description: Total size of artifacts in bytes
 *           example: 15000000000
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Creation timestamp
 *         updated_at:
 *           type: string
 *           format: date-time
 *           description: Last update timestamp
 */

/**
 * Artifact Storage Location model for path configuration
 * @description Sequelize model representing storage location configuration from config.yaml
 * @type {import('sequelize').Model}
 */
const ArtifactStorageLocation = db.define(
  'artifact_storage_locations',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique storage location identifier',
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Display name for the storage location',
    },
    path: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      comment: 'Filesystem path for artifact storage',
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isIn: [['iso', 'image', 'provisioning']],
      },
      comment: 'Type of artifacts stored (iso, image, or provisioning)',
    },
    enabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      comment: 'Whether this storage location is active',
    },
    config_hash: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Hash of configuration for change detection',
    },
    file_count: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: 'Cached count of artifacts in this location',
    },
    total_size: {
      type: DataTypes.BIGINT,
      defaultValue: 0,
      comment: 'Cached total size of artifacts in bytes',
    },
    last_scan_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Timestamp of last filesystem scan',
    },
    scan_errors: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: 'Count of consecutive scan errors',
    },
    last_error_message: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Last error message encountered during scan',
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'Timestamp when location was created',
    },
    updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'Timestamp when location was last updated',
    },
  },
  {
    freezeTableName: true,
    indexes: [
      {
        fields: ['type'],
        name: 'idx_storage_location_type',
      },
      {
        fields: ['enabled'],
        name: 'idx_storage_location_enabled',
      },
      {
        unique: true,
        fields: ['path'],
        name: 'unique_storage_location_path',
      },
    ],
    comment: 'Artifact storage location configuration synchronized from config.yaml',
  }
);

export default ArtifactStorageLocation;
