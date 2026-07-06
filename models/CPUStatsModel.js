import { Sequelize } from 'sequelize';
import db from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     CPUStats:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         host:
 *           type: string
 *           description: Host where the data was collected
 *           example: "hv-04"
 *         cpu_count:
 *           type: integer
 *           description: Number of CPU cores
 *           example: 8
 *         cpu_utilization_pct:
 *           type: number
 *           format: float
 *           description: Overall CPU utilization percentage
 *           example: 45.2
 *         user_pct:
 *           type: number
 *           format: float
 *           description: User CPU time percentage
 *           example: 25.1
 *         system_pct:
 *           type: number
 *           format: float
 *           description: System CPU time percentage
 *           example: 15.3
 *         idle_pct:
 *           type: number
 *           format: float
 *           description: Idle CPU time percentage
 *           example: 54.8
 *         iowait_pct:
 *           type: number
 *           format: float
 *           description: I/O wait CPU time percentage
 *           example: 4.8
 *         load_avg_1min:
 *           type: number
 *           format: float
 *           description: 1-minute load average
 *           example: 2.1
 *         load_avg_5min:
 *           type: number
 *           format: float
 *           description: 5-minute load average
 *           example: 1.8
 *         load_avg_15min:
 *           type: number
 *           format: float
 *           description: 15-minute load average
 *           example: 1.5
 *         processes_running:
 *           type: integer
 *           description: Number of running processes
 *           example: 12
 *         processes_blocked:
 *           type: integer
 *           description: Number of blocked processes
 *           example: 2
 *         context_switches:
 *           type: integer
 *           format: int64
 *           description: Context switches since boot
 *           example: 1234567
 *         interrupts:
 *           type: integer
 *           format: int64
 *           description: Interrupts per second
 *           example: 9876543
 *         system_calls:
 *           type: integer
 *           format: int64
 *           description: System calls per second
 *         page_faults:
 *           type: integer
 *           format: int64
 *           description: Page faults per second
 *         page_ins:
 *           type: integer
 *           format: int64
 *           description: Pages paged in per second
 *         page_outs:
 *           type: integer
 *           format: int64
 *           description: Pages paged out per second
 *         per_core_data:
 *           type: string
 *           description: >-
 *             Raw JSON string of per-core CPU utilization data. The /monitoring/system/cpu
 *             endpoint exposes a parsed `per_core_parsed` array (replacing this raw field)
 *             when include_cores=true.
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
const CPUStats = db.define(
  'cpu_stats',
  {
    host: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Host where the data was collected',
    },
    cpu_count: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Number of CPU cores/threads',
    },
    cpu_utilization_pct: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Overall CPU utilization percentage',
    },
    user_pct: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'User CPU time percentage',
    },
    system_pct: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'System CPU time percentage',
    },
    idle_pct: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Idle CPU time percentage',
    },
    iowait_pct: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'I/O wait CPU time percentage',
    },
    load_avg_1min: {
      type: DataTypes.DECIMAL(8, 2),
      allowNull: true,
      comment: '1-minute load average',
    },
    load_avg_5min: {
      type: DataTypes.DECIMAL(8, 2),
      allowNull: true,
      comment: '5-minute load average',
    },
    load_avg_15min: {
      type: DataTypes.DECIMAL(8, 2),
      allowNull: true,
      comment: '15-minute load average',
    },
    processes_running: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Number of running processes',
    },
    processes_blocked: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Number of blocked processes',
    },
    context_switches: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Context switches since boot',
    },
    interrupts: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Interrupts per second',
    },
    system_calls: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'System calls per second',
    },
    page_faults: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Page faults per second',
    },
    page_ins: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Pages paged in per second',
    },
    page_outs: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Pages paged out per second',
    },
    per_core_data: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'JSON string containing per-core CPU utilization data',
    },
    scan_timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'When this data was collected',
    },
  },
  {
    freezeTableName: true,
    comment: 'CPU performance statistics and load metrics',
    indexes: [
      {
        fields: ['host', 'scan_timestamp'],
      },
      {
        fields: ['scan_timestamp'],
      },
      {
        fields: ['host'],
      },
      {
        fields: ['cpu_utilization_pct'],
      },
    ],
  }
);

export default CPUStats;
