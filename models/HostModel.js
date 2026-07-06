import { Sequelize } from 'sequelize';
import { coreDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     Host:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Unique identifier for the host
 *           example: 1
 *         name:
 *           type: string
 *           description: Host name or identifier
 *           example: "omnios-host-01"
 *         port:
 *           type: string
 *           description: Port number for host communication
 *           example: "5001"
 *         proto:
 *           type: string
 *           description: Protocol used for communication
 *           example: "https"
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Host creation timestamp
 *         updated_at:
 *           type: string
 *           format: date-time
 *           description: Host last update timestamp
 */
const Hosts = db.define(
  'hosts',
  {
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    port: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    proto: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'https',
    },
  },
  {
    freezeTableName: true,
  }
);

export default Hosts;
