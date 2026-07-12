import { Sequelize } from 'sequelize';
import { coreDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     Zone:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         name:
 *           type: string
 *           description: Zone name
 *           example: "web-server-01"
 *         zone_id:
 *           type: string
 *           description: OmniOS zone identifier
 *           example: "zone-uuid-12345"
 *         host:
 *           type: string
 *           description: Host where the zone is running
 *           example: "omnios-host-01"
 *         status:
 *           type: string
 *           description: Current zone status (suspended = a bhyve suspend checkpoint exists)
 *           enum: [configured, incomplete, installed, ready, running, shutting_down, down, suspended]
 *           example: "running"
 *         brand:
 *           type: string
 *           description: Zone brand (bhyve, kvm, lx, etc.)
 *           example: "bhyve"
 *         vnc_port:
 *           type: integer
 *           description: Assigned VNC port for console access
 *           example: 5901
 *         is_orphaned:
 *           type: boolean
 *           description: Whether zone exists in DB but not on system
 *           example: false
 *         auto_discovered:
 *           type: boolean
 *           description: Whether zone was automatically discovered
 *           example: true
 *         last_seen:
 *           type: string
 *           format: date-time
 *           description: Last time zone was detected on system
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Zone creation timestamp
 *         server_id:
 *           type: string
 *           description: Numeric server identifier for VNIC naming (up to 8 digits)
 *           example: "00001234"
 *         vm_type:
 *           type: string
 *           description: VM type classification for VNIC naming
 *           enum: [template, development, production, firewall, other]
 *           example: "production"
 *         notes:
 *           type: string
 *           nullable: true
 *           description: Free-form user notes / annotations for this zone
 *           example: "Primary web server - do not stop during business hours"
 *         tags:
 *           type: array
 *           nullable: true
 *           description: User-defined tags for categorization and filtering
 *           items:
 *             type: string
 *           example: ["web", "production", "critical"]
 *         updated_at:
 *           type: string
 *           format: date-time
 *           description: Zone last update timestamp
 */
const Zones = db.define(
  'zones',
  {
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Zone name as it appears in the system',
    },
    zone_id: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      comment: 'Unique zone identifier from OmniOS',
    },
    host: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Host where the zone is running',
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'configured',
      comment: 'Current zone status (configured, installed, running, etc.)',
    },
    brand: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Zone brand (bhyve, kvm, lx, illumos, etc.)',
    },
    vnc_port: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Assigned VNC port for console access',
    },
    is_orphaned: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Whether zone exists in database but not on system',
    },
    auto_discovered: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Whether zone was automatically discovered by system scan',
    },
    last_seen: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'Last time zone was detected during system scan',
    },
    server_id: {
      type: DataTypes.STRING(8),
      allowNull: true,
      unique: true,
      comment: 'Numeric server identifier for VNIC naming (up to 8 digits)',
    },
    vm_type: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'production',
      comment: 'VM type classification (template, development, production, firewall, other)',
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Free-form user notes or annotations for this zone',
    },
    tags: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'User-defined tags for categorization and filtering',
    },
    configuration: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Full zone configuration from zadm show including autoboot and attributes',
    },
  },
  {
    freezeTableName: true,
    comment: 'Zone management and metadata storage',
  }
);

export default Zones;
