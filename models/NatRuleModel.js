import { Sequelize } from 'sequelize';
import { coreDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     NatRule:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           description: Unique identifier
 *           example: "123e4567-e89b-12d3-a456-426614174000"
 *         bridge:
 *           type: string
 *           description: Interface name
 *           example: "igb0"
 *         subnet:
 *           type: string
 *           description: Source subnet
 *           example: "10.0.0.0/24"
 *         target:
 *           type: string
 *           description: Target address
 *           example: "0/32"
 *         protocol:
 *           type: string
 *           description: Protocol
 *           example: "tcp/udp"
 *         type:
 *           type: string
 *           description: NAT type (map, rdr, bimap)
 *           example: "map"
 *         raw_rule:
 *           type: string
 *           description: Full rule string
 *         description:
 *           type: string
 *           description: Optional description
 *         created_by:
 *           type: string
 *           description: Creator of the rule
 *         created_at:
 *           type: string
 *           format: date-time
 *         updated_at:
 *           type: string
 *           format: date-time
 */
const NatRules = db.define(
  'nat_rules',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique identifier',
    },
    bridge: { type: DataTypes.STRING, allowNull: false, comment: 'Interface name' },
    subnet: { type: DataTypes.STRING, allowNull: false, comment: 'Source subnet' },
    target: { type: DataTypes.STRING, allowNull: false, comment: 'Target address' },
    protocol: { type: DataTypes.STRING, allowNull: false, comment: 'Protocol' },
    type: { type: DataTypes.STRING, allowNull: false, comment: 'NAT type (map, rdr, bimap)' }, // map, rdr, bimap
    raw_rule: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'The exact rule string as it appears in ipnat.conf',
    },
    description: { type: DataTypes.STRING, comment: 'Optional description' },
    created_by: { type: DataTypes.STRING, comment: 'Creator of the rule' },
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
    indexes: [
      {
        unique: true,
        fields: ['raw_rule'],
        name: 'unique_nat_rule',
      },
    ],
    comment: 'NAT rules synchronized with /etc/ipf/ipnat.conf',
  }
);

export default NatRules;
