import { Sequelize } from 'sequelize';
import { metricsStorageDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     Disk:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         host:
 *           type: string
 *           description: Host where the disk is located
 *           example: "hv-04"
 *         disk_index:
 *           type: integer
 *           description: Disk index from format command
 *           example: 0
 *         device_name:
 *           type: string
 *           description: Device name (c0t5F8DB4C101905B5Ad0)
 *           example: "c0t5F8DB4C101905B5Ad0"
 *         serial_number:
 *           type: string
 *           description: Disk serial number extracted from device name
 *           example: "5F8DB4C101905B5A"
 *         manufacturer:
 *           type: string
 *           description: Disk manufacturer
 *           example: "ATA"
 *         model:
 *           type: string
 *           description: Disk model
 *           example: "PNY CS900 120GB"
 *         firmware:
 *           type: string
 *           description: Firmware version
 *           example: "0613"
 *         capacity:
 *           type: string
 *           description: Disk capacity with units
 *           example: "111.79GB"
 *         capacity_bytes:
 *           type: string
 *           description: Disk capacity in bytes (string for large numbers)
 *           example: "120034123776"
 *         device_path:
 *           type: string
 *           description: Full device path
 *           example: "/scsi_vhci/disk@g5f8db4c101905b5a"
 *         disk_type:
 *           type: string
 *           description: Type of disk (SSD, HDD, etc.)
 *           example: "SSD"
 *         interface_type:
 *           type: string
 *           description: Interface type (SATA, SAS, etc.)
 *           example: "SATA"
 *         pool_assignment:
 *           type: string
 *           description: ZFS pool this disk belongs to (if any)
 *           example: "Array-0"
 *         is_available:
 *           type: boolean
 *           description: Whether disk is available for use
 *           example: true
 *         removable:
 *           type: boolean
 *           nullable: true
 *           description: Removable media (diskinfo FLRS R flag)
 *           example: false
 *         faulty:
 *           type: boolean
 *           nullable: true
 *           description: Faulted per fmd (diskinfo FLRS F flag; null = unknown)
 *           example: false
 *         chassis:
 *           type: integer
 *           nullable: true
 *           description: Physical chassis number (diskinfo LOCATION; 0 = host chassis)
 *           example: 0
 *         bay:
 *           type: integer
 *           nullable: true
 *           description: Physical bay/slot number within the chassis (diskinfo LOCATION)
 *           example: 5
 *         scan_timestamp:
 *           type: string
 *           format: date-time
 *           description: When this data was collected
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Record creation timestamp
 *         updated_at:
 *           type: string
 *           format: date-time
 *           description: Record last update timestamp
 */
const Disks = db.define(
  'disks',
  {
    host: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Host where the disk is located',
    },
    disk_index: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: 'Disk index from format command output',
    },
    device_name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Device name (e.g., c0t5F8DB4C101905B5Ad0)',
    },
    serial_number: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Disk serial number extracted from device name',
    },
    manufacturer: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Disk manufacturer (ATA, SEAGATE, etc.)',
    },
    model: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Disk model number',
    },
    firmware: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Firmware version',
    },
    capacity: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Disk capacity with units (e.g., 111.79GB)',
    },
    capacity_bytes: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Disk capacity in bytes (string for large numbers)',
    },
    device_path: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Full device path (/scsi_vhci/disk@g...)',
    },
    disk_type: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Type of disk (SSD, HDD, etc.)',
    },
    interface_type: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Interface type (SATA, SAS, SCSI, etc.)',
    },
    pool_assignment: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'ZFS pool this disk belongs to (if any)',
    },
    is_available: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      comment: 'Whether disk is available for pool assignment',
    },
    removable: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      comment: 'Removable media (diskinfo FLRS R flag)',
    },
    faulty: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      comment: 'Faulted per fmd (diskinfo FLRS F flag; null = unknown)',
    },
    chassis: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Physical chassis number (diskinfo LOCATION; 0 = host chassis)',
    },
    bay: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Physical bay/slot number within the chassis (diskinfo LOCATION)',
    },
    scan_timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When this data was collected',
    },
  },
  {
    freezeTableName: true,
    comment: 'Physical disk inventory and properties',
    indexes: [
      {
        unique: true,
        fields: ['host', 'device_name'], // Remove scan_timestamp to allow updates
      },
      {
        fields: ['host', 'scan_timestamp'],
      },
      {
        fields: ['serial_number'],
      },
      {
        fields: ['pool_assignment'],
      },
      {
        fields: ['is_available'],
      },
      {
        fields: ['scan_timestamp'],
      },
    ],
  }
);

export default Disks;
