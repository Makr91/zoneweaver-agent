/**
 * @fileoverview Settings schema — zone management section
 * @description zones (discovery, task limits, orchestration, resource
 * validation). Field shape and `default` semantics per SettingsSchema.js
 * (the aggregating index).
 */

export const ZONES_SCHEMA = {
  zones: {
    description: 'Zone management configuration',
    requires_restart: false,
    properties: {
      discovery_interval: {
        type: 'integer',
        description: 'Seconds between automatic zone discovery scans',
        default: 300,
        min: 10,
      },
      auto_discovery: {
        type: 'boolean',
        description: 'Enable automatic zone discovery',
        default: true,
      },
      max_concurrent_tasks: {
        type: 'integer',
        description: 'Maximum concurrent zone operations',
        default: 5,
        min: 1,
        max: 50,
      },
      task_timeout: {
        type: 'integer',
        description: 'Default command execution timeout in seconds',
        default: 300,
        min: 30,
      },
      task_poll_interval: {
        type: 'integer',
        description: 'Seconds between task queue polls',
        default: 2,
        min: 1,
      },
      resume_pending_tasks_on_start: {
        type: 'boolean',
        description:
          'Keep queued (pending) tasks across an agent restart instead of cancelling them at boot',
        default: false,
      },
      orphan_retention: {
        type: 'integer',
        description: 'Days to keep orphaned zones in database',
        default: 7,
        min: 1,
      },
      default_pagination_limit: {
        type: 'integer',
        description: 'Default items per page for list endpoints',
        default: 50,
        min: 10,
        max: 500,
      },
      server_id_start: {
        type: 'integer',
        description: 'Starting server_id for auto-generation (set per-host for HA/distributed)',
        default: 1,
        min: 1,
      },
      prefix_zone_names: {
        type: 'boolean',
        description: 'Prefix zone names with server_id',
        default: true,
      },
      prefix_datasets: {
        type: 'boolean',
        description: 'Prefix dataset paths with server_id',
        default: true,
      },
      orchestration: {
        type: 'object',
        description: 'Priority-based zone orchestration',
        properties: {
          enabled: {
            type: 'boolean',
            description: 'Enable zone orchestration (agent controls zone lifecycle)',
            default: false,
          },
          take_control_on_startup: {
            type: 'boolean',
            description: 'Take lifecycle control from svc:/system/zones on startup',
            default: false,
          },
          return_control_on_shutdown: {
            type: 'boolean',
            description: 'Return lifecycle control to svc:/system/zones on shutdown',
            default: true,
          },
          default_strategy: {
            type: 'string',
            description: 'Default orchestration strategy',
            default: 'parallel_by_priority',
            enum: ['sequential', 'parallel_by_priority', 'staggered'],
          },
          timeouts: {
            type: 'object',
            description: 'Orchestration timeouts in seconds',
            properties: {
              zone_shutdown: {
                type: 'integer',
                description: 'Per-zone shutdown timeout',
                default: 120,
                min: 10,
                max: 3600,
              },
              total_orchestration: {
                type: 'integer',
                description: 'Total orchestration timeout',
                default: 900,
                min: 60,
                max: 7200,
              },
              priority_group_delay: {
                type: 'integer',
                description: 'Delay between priority groups',
                default: 30,
                min: 0,
                max: 300,
              },
            },
          },
          priorities: {
            type: 'object',
            description: 'Priority system configuration',
            properties: {
              default_priority: {
                type: 'integer',
                description: 'Priority for zones without a boot_priority attribute',
                default: 95,
                min: 1,
                max: 100,
              },
            },
          },
          failure_handling: {
            type: 'object',
            description: 'Behavior when zones fail to stop',
            properties: {
              default_action: {
                type: 'string',
                description: 'Default action on failures',
                default: 'abort',
                enum: ['abort', 'continue'],
              },
              allow_emergency_override: {
                type: 'boolean',
                description: 'Allow emergency override of failure handling',
                default: true,
              },
            },
          },
        },
      },
      resource_validation: {
        type: 'object',
        description: 'Resource over-provisioning prevention',
        properties: {
          enabled: {
            type: 'boolean',
            description: 'Validate resource availability before create/modify',
            default: true,
          },
          storage: {
            type: 'object',
            description: 'Storage validation',
            properties: {
              strategy: {
                type: 'string',
                description: 'Accounting strategy',
                default: 'committed',
                enum: ['committed', 'provisioned', 'none'],
              },
              thresholds: {
                type: 'object',
                description: 'Utilization thresholds (percent)',
                properties: {
                  warning: {
                    type: 'integer',
                    description: 'Warning threshold',
                    default: 70,
                    min: 1,
                    max: 100,
                  },
                  critical: {
                    type: 'integer',
                    description: 'Critical threshold',
                    default: 80,
                    min: 1,
                    max: 100,
                  },
                },
              },
            },
          },
          memory: {
            type: 'object',
            description: 'Memory validation',
            properties: {
              strategy: {
                type: 'string',
                description: 'Accounting strategy',
                default: 'committed',
                enum: ['committed', 'provisioned', 'none'],
              },
              arc_accounting: {
                type: 'boolean',
                description: 'Treat ZFS ARC as reclaimable in memory accounting',
                default: true,
              },
              thresholds: {
                type: 'object',
                description: 'Utilization thresholds (percent)',
                properties: {
                  warning: {
                    type: 'integer',
                    description: 'Warning threshold',
                    default: 80,
                    min: 1,
                    max: 100,
                  },
                  critical: {
                    type: 'integer',
                    description: 'Critical threshold',
                    default: 90,
                    min: 1,
                    max: 100,
                  },
                },
              },
            },
          },
          cpu: {
            type: 'object',
            description: 'CPU validation',
            properties: {
              strategy: {
                type: 'string',
                description: 'Accounting strategy',
                default: 'committed',
                enum: ['committed', 'provisioned', 'none'],
              },
              hard_limit: {
                type: 'integer',
                description: 'Hard vCPU allocation limit (percent of host CPUs)',
                default: 400,
                min: 100,
              },
              thresholds: {
                type: 'object',
                description: 'Utilization thresholds (percent)',
                properties: {
                  warning: {
                    type: 'integer',
                    description: 'Warning threshold',
                    default: 150,
                    min: 1,
                  },
                  critical: {
                    type: 'integer',
                    description: 'Critical threshold',
                    default: 300,
                    min: 1,
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
