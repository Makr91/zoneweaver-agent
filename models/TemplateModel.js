import { Sequelize } from 'sequelize';
import { coreDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @fileoverview Template model for Zoneweaver Agent template management
 * @description Defines the database model for locally-stored zone templates extracted from box registries
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Template:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           description: Unique template identifier
 *           example: "789e0123-e89b-12d3-a456-426614174002"
 *         source_name:
 *           type: string
 *           description: Name of the template source registry
 *           example: "Default Registry"
 *         organization:
 *           type: string
 *           description: Organization in the registry
 *           example: "startcloud"
 *         box_name:
 *           type: string
 *           description: Box name in the registry
 *           example: "omnios-base"
 *         version:
 *           type: string
 *           description: Box version number
 *           example: "1.0.0"
 *         provider:
 *           type: string
 *           description: Provider type (e.g., zone, lx)
 *           example: "zone"
 *         architecture:
 *           type: string
 *           description: Architecture name
 *           example: "amd64"
 *         dataset_path:
 *           type: string
 *           description: ZFS dataset path where template is stored
 *           example: "rpool/templates/startcloud/omnios-base/1.0.0"
 *         original_filename:
 *           type: string
 *           description: Original .box filename
 *           example: "omnios-base-1.0.0-zone-amd64.box"
 *         size:
 *           type: integer
 *           format: int64
 *           description: Size in bytes
 *           example: 1500000000
 *         checksum:
 *           type: string
 *           description: File checksum
 *           example: "abc123def456..."
 *         checksum_algorithm:
 *           type: string
 *           description: Checksum algorithm used
 *           example: "sha256"
 *         source_url:
 *           type: string
 *           description: Original download URL
 *         downloaded_at:
 *           type: string
 *           format: date-time
 *           description: When the template was downloaded
 *         last_verified:
 *           type: string
 *           format: date-time
 *           description: Last verification timestamp
 *         metadata:
 *           type: object
 *           description: JSON metadata from the box
 *         created_at:
 *           type: string
 *           format: date-time
 *         updated_at:
 *           type: string
 *           format: date-time
 */

/**
 * Template model for locally-stored zone templates
 * @description Sequelize model representing extracted templates from Vagrant-compatible registries
 * @type {import('sequelize').Model}
 */
const Template = db.define(
  'templates',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique template identifier',
    },
    source_name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Name of the template source registry',
    },
    organization: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Organization in the registry',
    },
    box_name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Box name in the registry',
    },
    version: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Box version number',
    },
    provider: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Provider type (e.g., zone, lx)',
    },
    architecture: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Architecture name (e.g., amd64)',
    },
    dataset_path: {
      type: DataTypes.TEXT,
      allowNull: false,
      unique: true,
      comment: 'ZFS dataset path where template is stored',
    },
    original_filename: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Original .box filename',
    },
    size: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Size in bytes',
    },
    checksum: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'File checksum',
    },
    checksum_algorithm: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: {
        isIn: [['md5', 'sha1', 'sha256']],
      },
      comment: 'Checksum algorithm used',
    },
    source_url: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Original download URL from registry',
    },
    downloaded_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When the template was downloaded',
    },
    last_verified: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Last time the ZFS dataset was verified',
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'JSON metadata from the box',
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'Record creation timestamp',
    },
    updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'Record last update timestamp',
    },
  },
  {
    freezeTableName: true,
    indexes: [
      {
        fields: ['source_name'],
        name: 'idx_template_source_name',
      },
      {
        fields: ['organization'],
        name: 'idx_template_organization',
      },
      {
        fields: ['box_name'],
        name: 'idx_template_box_name',
      },
      {
        fields: ['provider'],
        name: 'idx_template_provider',
      },
      {
        unique: true,
        fields: ['source_name', 'organization', 'box_name', 'version', 'provider', 'architecture'],
        name: 'unique_template_identity',
      },
      {
        unique: true,
        fields: ['dataset_path'],
        name: 'unique_template_dataset_path',
      },
    ],
    comment: 'Locally-stored zone templates extracted from Vagrant-compatible registries',
  }
);

export default Template;
