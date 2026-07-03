/**
 * @fileoverview Provisioning Profile Model for Zoneweaver Agent
 * @description Reusable named provisioning profiles that combine recipe, credentials,
 *              sync folders, and provisioners into a single configuration
 */

import { Sequelize } from 'sequelize';
import db from '../config/Database.js';
import { v4 as uuidv4 } from 'uuid';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     ProvisioningProfile:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *         name:
 *           type: string
 *         description:
 *           type: string
 *         recipe_id:
 *           type: string
 *           format: uuid
 *         default_credentials:
 *           type: object
 *         default_sync_folders:
 *           type: array
 *           items:
 *             type: object
 *         default_provisioners:
 *           type: array
 *           items:
 *             type: object
 *         default_variables:
 *           type: object
 *         created_by:
 *           type: string
 *         created_at:
 *           type: string
 *           format: date-time
 *         updated_at:
 *           type: string
 *           format: date-time
 */
const ProvisioningProfiles = db.define(
  'provisioning_profiles',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: () => uuidv4(),
      primaryKey: true,
      comment: 'Unique profile identifier',
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      comment: 'Profile name (e.g., debian-ansible, omnios-shell)',
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Human-readable profile description',
    },
    recipe_id: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'Default zlogin recipe UUID for this profile',
    },
    default_credentials: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Default credentials: { username, password, ssh_key_path }',
    },
    default_sync_folders: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Default sync folder mappings: [{ source, dest }]',
    },
    default_provisioners: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Default provisioner configs: [{ type, playbook, scripts, ... }]',
    },
    default_variables: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: {},
      comment: 'Default variable values passed to recipe and provisioners',
    },
    created_by: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Who created this profile',
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'Creation timestamp',
    },
    updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'Last update timestamp',
    },
  },
  {
    freezeTableName: true,
    comment: 'Reusable provisioning profiles combining recipe, credentials, and provisioners',
  }
);

export default ProvisioningProfiles;
