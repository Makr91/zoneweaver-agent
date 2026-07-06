/**
 * @fileoverview Settings schema — monitoring and logging sections
 * @description host_monitoring, logging, reconciliation. Field shape and
 * `default` semantics per SettingsSchema.js (the aggregating index).
 */

export const MONITORING_SCHEMA = {
  host_monitoring: {
    description: 'Host monitoring and data collection configuration',
    requires_restart: true,
    properties: {
      enabled: { type: 'boolean', description: 'Enable host monitoring service', default: true },
      auto_enable_network_accounting: {
        type: 'boolean',
        description: 'Auto-enable network accounting on startup',
        default: true,
      },
      network_accounting_file: {
        type: 'string',
        description: 'Network accounting log file path',
        default: '/var/log/net.log',
      },
      intervals: {
        type: 'object',
        description: 'Collection intervals in seconds',
        properties: {
          network_config: {
            type: 'integer',
            description: 'Network config discovery',
            default: 10,
            min: 5,
          },
          network_stats: {
            type: 'integer',
            description: 'Network statistics collection',
            default: 10,
            min: 5,
          },
          network_usage: {
            type: 'integer',
            description: 'Network usage accounting',
            default: 10,
            min: 5,
          },
          storage: { type: 'integer', description: 'Storage discovery', default: 300, min: 10 },
          storage_frequent: {
            type: 'integer',
            description: 'Frequent storage metrics',
            default: 10,
            min: 5,
          },
          device_discovery: {
            type: 'integer',
            description: 'PCI device discovery',
            default: 60,
            min: 10,
          },
          system_metrics: {
            type: 'integer',
            description: 'CPU/memory/load metrics',
            default: 30,
            min: 5,
          },
        },
      },
      retention: {
        type: 'object',
        description: 'Data retention in days',
        properties: {
          network_stats: { type: 'integer', description: 'Network statistics', default: 7, min: 1 },
          network_usage: {
            type: 'integer',
            description: 'Network usage accounting',
            default: 30,
            min: 1,
          },
          network_config: {
            type: 'integer',
            description: 'Network configuration',
            default: 90,
            min: 1,
          },
          storage: { type: 'integer', description: 'Storage data', default: 90, min: 1 },
          cpu_stats: { type: 'integer', description: 'CPU statistics', default: 7, min: 1 },
          memory_stats: { type: 'integer', description: 'Memory statistics', default: 7, min: 1 },
          system_metrics: { type: 'integer', description: 'System metrics', default: 90, min: 1 },
          tasks: {
            type: 'integer',
            description: 'Completed/failed/cancelled tasks',
            default: 30,
            min: 1,
          },
        },
      },
      error_handling: {
        type: 'object',
        description: 'Collector error handling',
        properties: {
          max_consecutive_errors: {
            type: 'integer',
            description: 'Consecutive errors before a collector pauses',
            default: 5,
            min: 1,
          },
          retry_delay: {
            type: 'integer',
            description: 'Seconds to wait before retrying a failed collector',
            default: 30,
            min: 1,
          },
          reset_error_count_after: {
            type: 'integer',
            description: 'Seconds after which the error count resets',
            default: 3600,
            min: 60,
          },
        },
      },
      performance: {
        type: 'object',
        description: 'Collector performance limits',
        properties: {
          max_concurrent_scans: {
            type: 'integer',
            description: 'Maximum concurrent collection scans',
            default: 3,
            min: 1,
          },
          command_timeout: {
            type: 'integer',
            description: 'System command timeout in seconds',
            default: 30,
            min: 5,
          },
          batch_size: {
            type: 'integer',
            description: 'Database write batch size',
            default: 100,
            min: 10,
          },
        },
      },
    },
  },
  logging: {
    description: 'Application logging configuration',
    requires_restart: true,
    properties: {
      level: {
        type: 'string',
        description: 'Default log level',
        default: 'warn',
        enum: ['error', 'warn', 'info', 'debug'],
      },
      console_enabled: { type: 'boolean', description: 'Enable console output', default: false },
      log_directory: {
        type: 'string',
        description: 'Log file directory',
        default: '/var/log/zoneweaver-agent',
      },
      enable_compression: {
        type: 'boolean',
        description: 'Enable gzip compression of aged archive logs',
        default: true,
      },
      compression_age_days: {
        type: 'integer',
        description: 'Days before archived logs are compressed',
        default: 7,
        min: 1,
      },
      max_files: {
        type: 'integer',
        description: 'Maximum archived log files to keep per category',
        default: 30,
        min: 1,
      },
      performance_threshold_ms: {
        type: 'integer',
        description: 'Only log operations slower than this (ms)',
        default: 1000,
        min: 0,
      },
      categories: {
        type: 'object',
        description: 'Per-category log levels',
        properties: {
          monitoring: {
            type: 'string',
            description: 'Monitoring/collector logs',
            default: 'info',
            enum: ['error', 'warn', 'info', 'debug'],
          },
          database: {
            type: 'string',
            description: 'Database logs',
            default: 'warn',
            enum: ['error', 'warn', 'info', 'debug'],
          },
          tasks: {
            type: 'string',
            description: 'Task queue logs',
            default: 'info',
            enum: ['error', 'warn', 'info', 'debug'],
          },
          performance: {
            type: 'string',
            description: 'Performance logs',
            default: 'warn',
            enum: ['error', 'warn', 'info', 'debug'],
          },
          api_requests: {
            type: 'string',
            description: 'API request logs',
            default: 'info',
            enum: ['error', 'warn', 'info', 'debug'],
          },
          filesystem: {
            type: 'string',
            description: 'File system logs',
            default: 'warn',
            enum: ['error', 'warn', 'info', 'debug'],
          },
          auth: {
            type: 'string',
            description: 'Authentication logs',
            default: 'info',
            enum: ['error', 'warn', 'info', 'debug'],
          },
          websocket: {
            type: 'string',
            description: 'WebSocket/console logs',
            default: 'warn',
            enum: ['error', 'warn', 'info', 'debug'],
          },
        },
      },
    },
  },
  reconciliation: {
    description: 'Zone reconciliation configuration',
    requires_restart: false,
    properties: {
      enabled: {
        type: 'boolean',
        description: 'Enable periodic zone reconciliation',
        default: true,
      },
      interval: {
        type: 'integer',
        description: 'Reconciliation interval in seconds',
        default: 3600,
        min: 60,
      },
      log_level: {
        type: 'string',
        description: 'Reconciliation log level',
        default: 'warn',
        enum: ['error', 'warn', 'info', 'debug'],
      },
    },
  },
};
