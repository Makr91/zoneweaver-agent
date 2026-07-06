import { Sequelize } from 'sequelize';
import { metricsStorageDb as db } from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     ZFSDataset:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         host:
 *           type: string
 *           description: Host where the dataset is located
 *           example: "hv-04"
 *         name:
 *           type: string
 *           description: Full dataset name
 *           example: "Array-0/zones/2244--monitor-n2.home.m4kr.net/boot"
 *         pool:
 *           type: string
 *           description: Pool name (extracted from dataset name)
 *           example: "Array-0"
 *         type:
 *           type: string
 *           description: Dataset type
 *           example: "volume"
 *         creation:
 *           type: string
 *           description: Creation date/time
 *           example: "Thu Jul 25  1:35 2024"
 *         used:
 *           type: string
 *           description: Used space with units
 *           example: "5.20G"
 *         available:
 *           type: string
 *           description: Available space with units
 *           example: "176G"
 *         referenced:
 *           type: string
 *           description: Referenced space with units
 *           example: "4.39G"
 *         compressratio:
 *           type: string
 *           description: Compression ratio
 *           example: "1.63x"
 *         reservation:
 *           type: string
 *           description: Space reservation
 *           example: "none"
 *         volsize:
 *           type: string
 *           description: Volume size (for volumes)
 *           example: "60G"
 *         volblocksize:
 *           type: string
 *           description: Volume block size (for volumes)
 *           example: "16K"
 *         checksum:
 *           type: string
 *           description: Checksum algorithm
 *           example: "on"
 *         compression:
 *           type: string
 *           description: Compression algorithm
 *           example: "lz4"
 *         readonly:
 *           type: string
 *           description: Read-only setting
 *           example: "off"
 *         copies:
 *           type: string
 *           description: Number of copies
 *           example: "1"
 *         guid:
 *           type: string
 *           description: Dataset GUID
 *           example: "5878317788740649642"
 *         usedbysnapshots:
 *           type: string
 *           description: Space used by snapshots
 *           example: "829M"
 *         usedbydataset:
 *           type: string
 *           description: Space used by dataset
 *           example: "4.39G"
 *         usedbychildren:
 *           type: string
 *           description: Space used by children
 *           example: "0B"
 *         logicalused:
 *           type: string
 *           description: Logical space used
 *           example: "5.75G"
 *         logicalreferenced:
 *           type: string
 *           description: Logical space referenced
 *           example: "4.94G"
 *         written:
 *           type: string
 *           description: Space written
 *           example: "2.04G"
 *         mountpoint:
 *           type: string
 *           description: Mount point
 *           example: "/zones/myzone"
 *         mounted:
 *           type: string
 *           description: Mount status
 *           example: "yes"
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
const ZFSDatasets = db.define(
  'zfs_datasets',
  {
    host: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Host where the dataset is located',
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Full ZFS dataset name',
    },
    pool: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Pool name (extracted from dataset name)',
    },
    type: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Dataset type (filesystem, volume, snapshot)',
    },
    creation: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Creation date/time string',
    },
    used: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Used space with units',
    },
    used_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Used space in bytes',
    },
    available: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Available space with units',
    },
    available_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Available space in bytes',
    },
    referenced: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Referenced space with units',
    },
    referenced_bytes: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Referenced space in bytes',
    },
    compressratio: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Compression ratio',
    },
    reservation: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Space reservation',
    },
    volsize: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Volume size (for volume datasets)',
    },
    volblocksize: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Volume block size (for volume datasets)',
    },
    checksum: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Checksum algorithm',
    },
    compression: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Compression algorithm',
    },
    readonly: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Read-only setting',
    },
    copies: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Number of copies',
    },
    guid: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Dataset GUID',
    },
    usedbysnapshots: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Space used by snapshots',
    },
    usedbydataset: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Space used by dataset itself',
    },
    usedbychildren: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Space used by child datasets',
    },
    logicalused: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Logical space used',
    },
    logicalreferenced: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Logical space referenced',
    },
    written: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Space written since last snapshot',
    },
    mountpoint: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Mount point',
    },
    mounted: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Mount status',
    },
    scan_timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When this data was collected',
    },
  },
  {
    freezeTableName: true,
    comment: 'ZFS dataset properties and statistics (collected every 5 minutes)',
    indexes: [
      {
        fields: ['host', 'name', 'scan_timestamp'],
      },
      {
        fields: ['host', 'scan_timestamp'],
      },
      {
        fields: ['scan_timestamp'],
      },
      {
        fields: ['pool', 'scan_timestamp'],
      },
      {
        fields: ['type'],
      },
      {
        fields: ['name'],
      },
    ],
  }
);

export default ZFSDatasets;
