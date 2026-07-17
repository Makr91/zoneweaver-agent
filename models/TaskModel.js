import { Sequelize } from 'sequelize';
import { coreDb as db } from '../config/Database.js';

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
 *         machine_name:
 *           type: string
 *           description: Target machine name for the operation
 *           example: "web-server-01"
 *         operation:
 *           type: string
 *           description: >-
 *             Type of operation to perform — the complete server-defined set dispatched by the
 *             task executor (there is no console_start/console_stop; VNC auto-start is vnc_start).
 *             Consumers should still tolerate unknown values for forward-compatibility.
 *           enum:
 *             - start
 *             - stop
 *             - restart
 *             - delete
 *             - discover
 *             - vnc_start
 *             - zone_create_orchestration
 *             - zone_create_storage
 *             - zone_create_config
 *             - zone_create_install
 *             - zone_create_finalize
 *             - zone_modify
 *             - zone_setup
 *             - zone_provisioning_extract
 *             - zone_provisioning_stage
 *             - provisioner_import
 *             - provisioner_export
 *             - provisioner_catalog_install
 *             - snapshot_take
 *             - snapshot_restore
 *             - snapshot_delete
 *             - zone_wait_ssh
 *             - zone_sync
 *             - zone_sync_parent
 *             - zone_syncback
 *             - zone_syncback_parent
 *             - zone_shell
 *             - zone_docker_compose
 *             - zone_hook
 *             - zone_provision
 *             - zone_provision_parent
 *             - zone_provision_remote
 *             - zone_provision_orchestration
 *             - zone_clone_orchestration
 *             - service_enable
 *             - service_disable
 *             - service_restart
 *             - service_refresh
 *             - process_trace
 *             - network_config_discovery
 *             - network_usage_discovery
 *             - storage_discovery
 *             - storage_frequent_discovery
 *             - device_discovery
 *             - system_metrics_discovery
 *             - set_hostname
 *             - update_time_sync_config
 *             - force_time_sync
 *             - set_timezone
 *             - switch_time_sync_system
 *             - system_host_restart
 *             - system_host_reboot
 *             - system_host_reboot_fast
 *             - system_host_shutdown
 *             - system_host_poweroff
 *             - system_host_halt
 *             - system_host_runlevel_change
 *             - create_ip_address
 *             - delete_ip_address
 *             - enable_ip_address
 *             - disable_ip_address
 *             - create_vnic
 *             - delete_vnic
 *             - set_vnic_properties
 *             - create_aggregate
 *             - delete_aggregate
 *             - modify_aggregate_links
 *             - create_etherstub
 *             - delete_etherstub
 *             - create_vlan
 *             - delete_vlan
 *             - create_bridge
 *             - delete_bridge
 *             - modify_bridge_links
 *             - create_nat_rule
 *             - delete_nat_rule
 *             - configure_forwarding
 *             - dhcp_update_config
 *             - dhcp_add_host
 *             - dhcp_remove_host
 *             - dhcp_service_control
 *             - provisioning_network_setup
 *             - provisioning_network_teardown
 *             - pkg_install
 *             - pkg_uninstall
 *             - pkg_update
 *             - pkg_refresh
 *             - beadm_create
 *             - beadm_delete
 *             - beadm_activate
 *             - beadm_mount
 *             - beadm_unmount
 *             - repository_add
 *             - repository_remove
 *             - repository_modify
 *             - repository_enable
 *             - repository_disable
 *             - user_create
 *             - user_modify
 *             - user_delete
 *             - user_set_password
 *             - user_lock
 *             - user_unlock
 *             - group_create
 *             - group_modify
 *             - group_delete
 *             - role_create
 *             - role_modify
 *             - role_delete
 *             - zfs_create_dataset
 *             - zfs_destroy_dataset
 *             - zfs_set_properties
 *             - zfs_clone_dataset
 *             - zfs_promote_dataset
 *             - zfs_rename_dataset
 *             - zfs_create_snapshot
 *             - zfs_destroy_snapshot
 *             - zfs_rollback_snapshot
 *             - zfs_hold_snapshot
 *             - zfs_release_snapshot
 *             - zpool_create
 *             - zpool_destroy
 *             - zpool_set_properties
 *             - zpool_add_vdev
 *             - zpool_remove_vdev
 *             - zpool_replace_device
 *             - zpool_online_device
 *             - zpool_offline_device
 *             - zpool_scrub
 *             - zpool_stop_scrub
 *             - zpool_export
 *             - zpool_import
 *             - zpool_upgrade
 *             - file_move
 *             - file_copy
 *             - file_archive_create
 *             - file_archive_extract
 *             - artifact_download_url
 *             - artifact_scan_all
 *             - artifact_scan_location
 *             - artifact_delete_file
 *             - artifact_delete_folder
 *             - artifact_upload
 *             - artifact_move
 *             - artifact_copy
 *             - template_download
 *             - template_delete
 *             - template_upload
 *             - template_export
 *             - template_move
 *           example: "start"
 *         status:
 *           type: string
 *           description: >-
 *             Current task status (shared vocabulary with the Go agent). A
 *             parent whose children PARTIALLY failed lands in
 *             completed_with_errors — a real terminal status, not just a
 *             progress_info note.
 *           enum: [pending, prepared, running, completed, completed_with_errors, failed, cancelled]
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
 *         parent_task_id:
 *           type: string
 *           format: uuid
 *           nullable: true
 *           description: Parent task ID for grouped operations (e.g. provisioning pipeline)
 *         metadata:
 *           type: string
 *           nullable: true
 *           description: JSON string of task execution parameters
 *         progress_percent:
 *           type: number
 *           format: float
 *           description: Task completion percentage (0.00–100.00)
 *         progress_info:
 *           type: object
 *           nullable: true
 *           description: Detailed progress information (transferred bytes, speed, ETA, etc.)
 *         output:
 *           type: string
 *           nullable: true
 *           description: Task output — JSON array of {stream, data, timestamp} entries
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

// Agent API v1 wire vocabulary (architecture O1): task rows serialize with
// machine_name; the zone_name attribute/column stays internal (OmniOS domain naming).
Tasks.prototype.toJSON = function toJSON() {
  const { zone_name: machineName, ...values } = this.get({ plain: true });
  return { ...values, machine_name: machineName };
};

export default Tasks;
