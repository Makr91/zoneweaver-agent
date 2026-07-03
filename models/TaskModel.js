import { Sequelize } from 'sequelize';
import db from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @fileoverview Task model for Zoneweaver Agent task queue management
 * @description Defines the database model for managing zone operation tasks with priority and dependency support
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Task:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           description: Unique task identifier
 *           example: "123e4567-e89b-12d3-a456-426614174000"
 *         zone_name:
 *           type: string
 *           description: Target zone name for the operation
 *           example: "web-server-01"
 *         operation:
 *           type: string
 *           description: Type of operation to perform
 *           enum: [start, stop, restart, delete, console_start, console_stop, discover, service_enable, service_disable, service_restart, service_refresh, template_download, template_delete, template_upload, template_export]
 *           example: "start"
 *         status:
 *           type: string
 *           description: Current task status
 *           enum: [pending, running, completed, failed, cancelled]
 *           example: "pending"
 *         priority:
 *           type: integer
 *           description: Task priority (higher number = higher priority)
 *           example: 60
 *         created_by:
 *           type: string
 *           description: Entity that created the task
 *           example: "Zoneweaver-Production"
 *         depends_on:
 *           type: string
 *           format: uuid
 *           description: Task dependency (must complete before this task)
 *           example: "456e7890-e89b-12d3-a456-426614174001"
 *         error_message:
 *           type: string
 *           description: Error message if task failed
 *           example: "Zone not found"
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Task creation timestamp
 *         started_at:
 *           type: string
 *           format: date-time
 *           description: Task execution start timestamp
 *         completed_at:
 *           type: string
 *           format: date-time
 *           description: Task completion timestamp
 */

/**
 * Task priority constants
 * @description Defines standard priority levels for different operations
 */
export const TaskPriority = {
  CRITICAL: 100, // Delete operations
  HIGH: 80, // Stop operations
  MEDIUM: 60, // Start operations
  NORMAL: 60, // Alias for MEDIUM, whihch is stupid, we should just use MEDIUM
  SERVICE: 50, // Service operations
  LOW: 40, // Restart operations
  BACKGROUND: 20, // Discovery, console operations
};

/**
 * Task model for operation queue management
 * @description Sequelize model representing tasks in the operation queue
 * @type {import('sequelize').Model}
 */
const Tasks = db.define(
  'tasks',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique task identifier',
    },
    zone_name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Target zone name for the operation',
    },
    operation: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Type of operation (start, stop, restart, delete, etc.)',
    },
    status: {
      type: DataTypes.STRING,
      defaultValue: 'pending',
      comment: 'Current task status (pending, running, completed, failed, cancelled)',
    },
    priority: {
      type: DataTypes.INTEGER,
      defaultValue: TaskPriority.MEDIUM,
      comment: 'Task priority (higher number = higher priority)',
    },
    created_by: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Entity name that created the task',
    },
    depends_on: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'Task dependency - must complete before this task can run',
    },
    parent_task_id: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'Parent task ID for grouped operations (e.g. provisioning pipeline)',
    },
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Error message if task failed',
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'Timestamp when task was created',
    },
    started_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Timestamp when task execution started',
    },
    completed_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Timestamp when task completed',
    },
    metadata: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'JSON metadata for task execution (networking parameters, etc.)',
    },
    progress_percent: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0,
      allowNull: false,
      comment: 'Task completion percentage (0.00 to 100.00)',
    },
    progress_info: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Detailed progress information (transferred bytes, speed, ETA, etc.)',
    },
    output: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Task output (JSON array of {stream, data, timestamp} entries)',
    },
  },
  {
    freezeTableName: true,
    comment: 'Task queue for zone operations with priority and dependency management',
    indexes: [
      // Existing index (keep for backwards compatibility)
      {
        name: 'task_status_priority_idx',
        fields: ['status', 'priority'],
      },
      // Performance indexes for task queries
      {
        name: 'idx_tasks_created_at',
        fields: [{ name: 'created_at', order: 'DESC' }],
      },
      {
        name: 'idx_tasks_updated_at',
        fields: [{ name: 'updatedAt', order: 'DESC' }],
      },
      {
        name: 'idx_tasks_operation',
        fields: ['operation'],
      },
      {
        name: 'idx_tasks_operation_created_at',
        fields: ['operation', { name: 'created_at', order: 'DESC' }],
      },
      {
        name: 'idx_tasks_operation_updated_at',
        fields: ['operation', { name: 'updatedAt', order: 'DESC' }],
      },
    ],
  }
);

// Set up associations
Tasks.belongsTo(Tasks, { as: 'DependsOnTask', foreignKey: 'depends_on' });
Tasks.belongsTo(Tasks, { as: 'ParentTask', foreignKey: 'parent_task_id' });
Tasks.hasMany(Tasks, { as: 'SubTasks', foreignKey: 'parent_task_id' });

export default Tasks;
