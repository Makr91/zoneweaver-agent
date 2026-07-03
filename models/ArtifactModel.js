import { Sequelize } from 'sequelize';
import db from '../config/Database.js';
import ArtifactStorageLocation from './ArtifactStorageLocationModel.js';

const { DataTypes } = Sequelize;

/**
 * @fileoverview Artifact model for Zoneweaver Agent artifact management
 * @description Defines the database model for individual artifact files
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Artifact:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           description: Unique artifact identifier
 *           example: "456e7890-e89b-12d3-a456-426614174001"
 *         storage_location_id:
 *           type: string
 *           format: uuid
 *           description: Reference to storage location
 *           example: "123e4567-e89b-12d3-a456-426614174000"
 *         filename:
 *           type: string
 *           description: Name of the artifact file
 *           example: "ubuntu-22.04-server-amd64.iso"
 *         path:
 *           type: string
 *           description: Full filesystem path to the artifact
 *           example: "/data/isos/ubuntu-22.04-server-amd64.iso"
 *         size:
 *           type: integer
 *           format: int64
 *           description: File size in bytes
 *           example: 3500000000
 *         file_type:
 *           type: string
 *           description: Type of artifact (iso, image)
 *           enum: [iso, image]
 *           example: "iso"
 *         extension:
 *           type: string
 *           description: File extension
 *           example: ".iso"
 *         mime_type:
 *           type: string
 *           description: MIME type of the file
 *           example: "application/x-iso9660-image"
 *         checksum:
 *           type: string
 *           description: File checksum (provided by user or calculated by system)
 *           example: "abc123def456..."
 *         checksum_algorithm:
 *           type: string
 *           description: Algorithm used for checksum calculation
 *           enum: [md5, sha1, sha256]
 *           example: "sha256"
 *         source_url:
 *           type: string
 *           description: Original download URL if downloaded
 *           example: "https://releases.ubuntu.com/22.04/ubuntu-22.04-server-amd64.iso"
 *         discovered_at:
 *           type: string
 *           format: date-time
 *           description: When artifact was first discovered
 *         last_verified:
 *           type: string
 *           format: date-time
 *           description: Last filesystem verification timestamp
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
 * Artifact model for individual files
 * @description Sequelize model representing artifact files in storage locations
 * @type {import('sequelize').Model}
 */
const Artifact = db.define(
  'artifacts',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique artifact identifier',
    },
    storage_location_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: ArtifactStorageLocation,
        key: 'id',
      },
      comment: 'Reference to storage location',
    },
    filename: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Name of the artifact file',
    },
    path: {
      type: DataTypes.TEXT,
      allowNull: false,
      unique: true,
      comment: 'Full filesystem path to the artifact',
    },
    size: {
      type: DataTypes.BIGINT,
      allowNull: false,
      comment: 'File size in bytes',
    },
    file_type: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isIn: [['iso', 'image', 'provisioning']],
      },
      comment: 'Type of artifact (iso, image, or provisioning)',
    },
    extension: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'File extension (e.g., .iso, .vmdk)',
    },
    mime_type: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'MIME type of the file',
    },
    checksum: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'File checksum (provided by user or calculated by system)',
    },
    checksum_algorithm: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: {
        isIn: [['md5', 'sha1', 'sha256']],
      },
      comment: 'Algorithm used for checksum calculation',
    },
    checksum_verified: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      comment: 'Checksum verification status: true=verified, false=mismatch, null=not verified',
    },
    source_url: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Original download URL if downloaded from internet',
    },
    discovered_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When artifact was first discovered/created',
    },
    last_verified: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Last time file existence was verified on filesystem',
    },
  },
  {
    freezeTableName: true,
    indexes: [
      {
        fields: ['storage_location_id'],
        name: 'idx_artifact_storage_location',
      },
      {
        fields: ['file_type'],
        name: 'idx_artifact_file_type',
      },
      {
        fields: ['filename'],
        name: 'idx_artifact_filename',
      },
      {
        fields: ['size'],
        name: 'idx_artifact_size',
      },
      {
        fields: ['checksum'],
        name: 'idx_artifact_checksum',
      },
      {
        fields: ['discovered_at'],
        name: 'idx_artifact_discovered_at',
      },
      {
        unique: true,
        fields: ['path'],
        name: 'unique_artifact_path',
      },
    ],
    comment: 'Individual artifact files managed by the system',
  }
);

// Set up associations
Artifact.belongsTo(ArtifactStorageLocation, {
  foreignKey: 'storage_location_id',
  as: 'storage_location',
});

ArtifactStorageLocation.hasMany(Artifact, {
  foreignKey: 'storage_location_id',
  as: 'artifacts',
});

export default Artifact;
