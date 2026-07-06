/**
 * @fileoverview Settings schema — platform surface sections
 * @description api_docs, ui, docs, fault_management, system_logs,
 * file_browser. Field shape and `default` semantics per SettingsSchema.js
 * (the aggregating index).
 */

export const PLATFORM_SCHEMA = {
  api_docs: {
    description: 'API documentation configuration',
    requires_restart: true,
    properties: {
      enabled: {
        type: 'boolean',
        description: 'Enable Swagger API documentation at /api-docs',
        default: true,
      },
    },
  },
  ui: {
    description: 'Hyperweaver UI shim (Direct mode)',
    requires_restart: true,
    properties: {
      enabled: {
        type: 'boolean',
        description: 'Serve the Hyperweaver UI SPA at /ui',
        default: false,
      },
      path: {
        type: 'string',
        description: 'UI artifact directory (defaults to <install dir>/ui when unset)',
        default: '/opt/zoneweaver-agent/ui',
      },
    },
  },
  docs: {
    description: 'Bundled documentation site',
    requires_restart: true,
    properties: {
      enabled: {
        type: 'boolean',
        description: 'Serve the bundled docs site at /docs (ships inside the UI artifact)',
        default: true,
      },
    },
  },
  fault_management: {
    description: 'System fault management configuration',
    requires_restart: false,
    properties: {
      enabled: {
        type: 'boolean',
        description: 'Enable fault management monitoring',
        default: true,
      },
      cache_interval: {
        type: 'integer',
        description: 'Cache interval for fault data in seconds',
        default: 3600,
        min: 60,
      },
      timeout: {
        type: 'integer',
        description: 'Command timeout in seconds',
        default: 30,
        min: 5,
      },
      max_faults_displayed: {
        type: 'integer',
        description: 'Maximum faults to display',
        default: 50,
        min: 1,
      },
    },
  },
  system_logs: {
    description: 'System log viewing configuration',
    requires_restart: false,
    properties: {
      enabled: { type: 'boolean', description: 'Enable system log viewing', default: true },
      max_lines: {
        type: 'integer',
        description: 'Maximum lines to read from log files',
        default: 1000,
        min: 100,
      },
      default_tail_lines: {
        type: 'integer',
        description: 'Default number of lines for tail operations',
        default: 100,
        min: 10,
      },
      timeout: {
        type: 'integer',
        description: 'File read timeout in seconds',
        default: 30,
        min: 5,
      },
      max_concurrent_streams: {
        type: 'integer',
        description: 'Maximum concurrent WebSocket log streams',
        default: 10,
        min: 1,
      },
      stream_session_timeout: {
        type: 'integer',
        description: 'Log stream session timeout in seconds',
        default: 3600,
        min: 60,
      },
      allowed_paths: {
        type: 'array',
        items: 'string',
        description: 'Directories log viewing is allowed to read from',
        default: ['/var/log', '/var/adm', '/var/fm/fmd'],
      },
      security: {
        type: 'object',
        description: 'Log viewing restrictions',
        properties: {
          max_file_size_mb: {
            type: 'integer',
            description: 'Maximum readable log file size in MB',
            default: 100,
            min: 1,
          },
          forbidden_patterns: {
            type: 'array',
            items: 'string',
            description: 'Path patterns log viewing must never read',
            default: ['*.pid', '*.lock', '*/private/*'],
          },
        },
      },
    },
  },
  file_browser: {
    description: 'File browser configuration',
    requires_restart: false,
    properties: {
      enabled: { type: 'boolean', description: 'Enable file browser', default: true },
      upload_size_limit_gb: {
        type: 'integer',
        description: 'Maximum file upload size in GB',
        default: 50,
        min: 1,
      },
      security: {
        type: 'object',
        description: 'File browser restrictions',
        properties: {
          max_file_size_mb: {
            type: 'integer',
            description: 'Maximum file size in MB',
            default: 51200,
            min: 1,
          },
          max_edit_size_mb: {
            type: 'integer',
            description: 'Maximum editable text file size in MB',
            default: 100,
            min: 1,
          },
          max_directory_entries: {
            type: 'integer',
            description: 'Maximum entries returned per directory listing',
            default: 1000,
            min: 10,
          },
          prevent_traversal: {
            type: 'boolean',
            description: 'Block path traversal outside allowed roots',
            default: true,
          },
          forbidden_paths: {
            type: 'array',
            items: 'string',
            description: 'Paths the file browser must never touch',
            default: ['/dev', '/devices', '/system', '/platform', '/kernel', '/proc'],
          },
          forbidden_patterns: {
            type: 'array',
            items: 'string',
            description: 'Path patterns the file browser must never touch',
            default: [
              '*/dev/*',
              '*/devices/*',
              '/system/*',
              '*/platform/*',
              '*/kernel/*',
              '*/proc/*',
            ],
          },
        },
      },
      archive: {
        type: 'object',
        description: 'Archive create/extract operations',
        properties: {
          enabled: { type: 'boolean', description: 'Enable archive operations', default: true },
          max_archive_size_mb: {
            type: 'integer',
            description: 'Maximum archive size in MB',
            default: 10240,
            min: 1,
          },
          supported_formats: {
            type: 'array',
            items: 'string',
            description: 'Supported archive formats',
            default: ['zip', 'tar', 'tar.gz', 'tar.bz2', 'gz'],
          },
        },
      },
    },
  },
};
