import { Sequelize } from 'sequelize';
import { metricsSystemDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     PCIDevice:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         host:
 *           type: string
 *           description: Host where the device is located
 *           example: "hv-04"
 *         pci_address:
 *           type: string
 *           description: PCI device address (e.g., pciex8086,10fb)
 *           example: "pciex8086,10fb"
 *         vendor_id:
 *           type: string
 *           description: PCI vendor ID
 *           example: "8086"
 *         device_id:
 *           type: string
 *           description: PCI device ID
 *           example: "10fb"
 *         vendor_name:
 *           type: string
 *           description: Device vendor name
 *           example: "Intel Corporation"
 *         device_name:
 *           type: string
 *           description: Device description
 *           example: "82599ES 10-Gigabit SFI/SFP+ Network Connection"
 *         driver_name:
 *           type: string
 *           description: Driver name
 *           example: "ixgbe"
 *         driver_instance:
 *           type: integer
 *           description: Driver instance number
 *           example: 0
 *         driver_attached:
 *           type: boolean
 *           description: Whether driver is attached
 *           example: true
 *         device_category:
 *           type: string
 *           description: Device category (network, storage, display, usb, other)
 *           example: "network"
 *         pci_path:
 *           type: string
 *           description: Physical PCI device path
 *           example: "/pci@0,0/pci8086,340a@1c,1/pci108e,7b11@0"
 *         ppt_device_path:
 *           type: string
 *           description: PPT device path if assigned
 *           example: "/dev/ppt0"
 *         ppt_enabled:
 *           type: boolean
 *           description: Whether device is PPT-enabled
 *           example: false
 *         ppt_capable:
 *           type: boolean
 *           description: Whether device is capable of PPT (can be configured for passthrough)
 *           example: true
 *         assigned_to_zones:
 *           type: array
 *           description: Zones this device is assigned to
 *           items:
 *             type: object
 *             properties:
 *               zone_name:
 *                 type: string
 *               assignment_type:
 *                 type: string
 *               device_match:
 *                 type: string
 *               slot_assignment:
 *                 type: string
 *         found_in_network_interfaces:
 *           type: boolean
 *           description: Whether device found in network interface scan
 *           example: true
 *         found_in_disk_inventory:
 *           type: boolean
 *           description: Whether device found in disk inventory
 *           example: false
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
const PCIDevice = db.define(
  'pci_devices',
  {
    host: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Host where the device is located',
    },
    pci_address: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'PCI device address (e.g., pciex8086,10fb)',
    },
    vendor_id: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'PCI vendor ID (4-digit hex)',
    },
    device_id: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'PCI device ID (4-digit hex)',
    },
    vendor_name: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Device vendor name',
    },
    device_name: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Device description/name',
    },
    driver_name: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Driver name',
    },
    driver_instance: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Driver instance number',
    },
    driver_attached: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Whether driver is attached to device',
    },
    device_category: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Device category (network, storage, display, usb, other)',
    },
    pci_path: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Physical PCI device path',
    },
    ppt_device_path: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'PPT device path if assigned (e.g., /dev/ppt0)',
    },
    ppt_enabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Whether device is enabled for passthrough',
    },
    ppt_capable: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Whether device is capable of passthrough (can be configured)',
    },
    assigned_to_zones: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Array of zone assignments with details',
    },
    found_in_network_interfaces: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Whether device found in network interface collection',
    },
    found_in_disk_inventory: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Whether device found in disk inventory collection',
    },
    scan_timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When this data was collected',
    },
  },
  {
    freezeTableName: true,
    comment: 'PCI device inventory with passthrough capabilities and zone assignments',
    indexes: [
      {
        fields: ['host', 'pci_address'],
        unique: true,
      },
      {
        fields: ['host', 'scan_timestamp'],
      },
      {
        fields: ['device_category'],
      },
      {
        fields: ['ppt_enabled'],
      },
      {
        fields: ['ppt_capable'],
      },
      {
        fields: ['driver_name'],
      },
    ],
  }
);

export default PCIDevice;
