import { Sequelize } from 'sequelize';
import { coreDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     DhcpHost:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           description: Unique identifier
 *           example: "123e4567-e89b-12d3-a456-426614174000"
 *         hostname:
 *           type: string
 *           description: Hostname for the static entry
 *           example: "web-server-01"
 *         mac:
 *           type: string
 *           description: MAC address
 *           example: "aa:bb:cc:dd:ee:ff"
 *         ip:
 *           type: string
 *           description: Fixed IP address
 *           example: "192.168.1.50"
 *         description:
 *           type: string
 *           description: Optional description
 *         created_by:
 *           type: string
 *           description: Creator of the entry
 *         created_at:
 *           type: string
 *           format: date-time
 *         updated_at:
 *           type: string
 *           format: date-time
 */
const DhcpHosts = db.define(
  'dhcp_hosts',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique identifier',
    },
    hostname: { type: DataTypes.STRING, allowNull: false, unique: true, comment: 'Hostname' },
    mac: { type: DataTypes.STRING, allowNull: false, unique: true, comment: 'MAC address' },
    ip: { type: DataTypes.STRING, allowNull: false, unique: true, comment: 'Fixed IP address' },
    description: { type: DataTypes.STRING, comment: 'Optional description' },
    created_by: { type: DataTypes.STRING, comment: 'Creator of the entry' },
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
        fields: ['mac'],
      },
      {
        unique: true,
        fields: ['ip'],
      },
    ],
    comment: 'DHCP static host entries synchronized with /etc/dhcpd.conf',
  }
);

export default DhcpHosts;
