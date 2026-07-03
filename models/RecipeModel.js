/**
 * @fileoverview Zlogin Automation Recipe Model for Zoneweaver Agent
 * @description Stores reusable zlogin automation recipes for early-boot zone configuration
 */

import { Sequelize } from 'sequelize';
import db from '../config/Database.js';
import { v4 as uuidv4 } from 'uuid';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     Recipe:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *         name:
 *           type: string
 *         description:
 *           type: string
 *         os_family:
 *           type: string
 *         brand:
 *           type: string
 *         is_default:
 *           type: boolean
 *         boot_string:
 *           type: string
 *         login_prompt:
 *           type: string
 *         shell_prompt:
 *           type: string
 *         timeout_seconds:
 *           type: integer
 *         steps:
 *           type: array
 *           items:
 *             type: object
 *         variables:
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
const Recipes = db.define(
  'recipes',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: () => uuidv4(),
      primaryKey: true,
      comment: 'Unique recipe identifier',
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      comment: 'Recipe name (e.g., debian-netplan, omnios-dladm)',
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Human-readable description of what this recipe does',
    },
    os_family: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Target OS family: linux, solaris, windows',
    },
    brand: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'bhyve',
      comment: 'Target zone brand: bhyve, lx, kvm',
    },
    is_default: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Whether this is the default recipe for its os_family+brand combo',
    },
    boot_string: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Pattern indicating OS has booted (e.g., "Web console:")',
    },
    login_prompt: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'login:',
      comment: 'Login prompt pattern (e.g., "login:")',
    },
    shell_prompt: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: ':~$',
      comment: 'Shell ready pattern (e.g., ":~$", "#")',
    },
    timeout_seconds: {
      type: DataTypes.INTEGER,
      defaultValue: 300,
      comment: 'Max wait time for boot in seconds',
    },
    steps: {
      type: DataTypes.JSON,
      allowNull: false,
      comment: 'Array of automation steps: wait, send, command, template, delay',
    },
    variables: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: {},
      comment: 'Default variable values for template resolution',
    },
    created_by: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Who created this recipe',
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
    comment: 'Zlogin automation recipes for early-boot zone configuration',
    indexes: [
      {
        name: 'idx_recipes_os_family_brand',
        fields: ['os_family', 'brand'],
      },
      {
        name: 'idx_recipes_is_default',
        fields: ['is_default'],
      },
    ],
  }
);

export default Recipes;
