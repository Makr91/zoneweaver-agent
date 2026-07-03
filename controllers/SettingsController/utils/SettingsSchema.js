/**
 * @fileoverview Settings schema definition
 */

/**
 * Static schema describing all configuration sections, their properties,
 * types, descriptions, defaults, valid ranges, and restart requirements.
 */
export const SETTINGS_SCHEMA = {
  server: {
    description: 'HTTP/HTTPS server configuration',
    requires_restart: true,
    properties: {
      http_port: {
        type: 'integer',
        description: 'HTTP server port',
        default: 5000,
        min: 1,
        max: 65535,
      },
      https_port: {
        type: 'integer',
        description: 'HTTPS server port',
        default: 5001,
        min: 1,
        max: 65535,
      },
    },
  },
  ssl: {
    description: 'SSL/TLS certificate configuration',
    requires_restart: true,
    properties: {
      enabled: { type: 'boolean', description: 'Enable HTTPS', default: true },
      generate_ssl: {
        type: 'boolean',
        description: 'Auto-generate self-signed SSL certificates',
        default: true,
      },
      key_path: {
        type: 'string',
        description: 'Path to SSL private key file',
        default: '/etc/zoneweaver-agent/ssl/server.key',
      },
      cert_path: {
        type: 'string',
        description: 'Path to SSL certificate file',
        default: '/etc/zoneweaver-agent/ssl/server.crt',
      },
    },
  },
  cors: {
    description: 'Cross-Origin Resource Sharing configuration',
    requires_restart: true,
    properties: {
      whitelist: {
        type: 'array',
        items: 'string',
        description: 'Allowed origins for CORS requests',
        default: [],
      },
    },
  },
  database: {
    description: 'Database connection configuration',
    requires_restart: true,
    properties: {
      dialect: {
        type: 'string',
        description: 'Database dialect',
        default: 'sqlite',
        enum: ['sqlite'],
      },
      storage: {
        type: 'string',
        description: 'SQLite database file path',
        default: '/var/lib/zoneweaver-agent/database/database.sqlite',
      },
      logging: { type: 'boolean', description: 'Enable SQL query logging', default: false },
    },
  },
  api_keys: {
    description: 'API key authentication configuration',
    requires_restart: false,
    properties: {
      bootstrap_enabled: {
        type: 'boolean',
        description: 'Enable bootstrap key generation endpoint',
        default: true,
      },
      bootstrap_auto_disable: {
        type: 'boolean',
        description: 'Auto-disable bootstrap after first key generation',
        default: true,
      },
      key_length: {
        type: 'integer',
        description: 'Random byte length for API key generation',
        default: 64,
        min: 32,
        max: 256,
      },
      hash_rounds: {
        type: 'integer',
        description: 'bcrypt hash rounds for API key storage',
        default: 12,
        min: 4,
        max: 31,
      },
    },
  },
  stats: {
    description: 'Server statistics endpoint configuration',
    requires_restart: true,
    properties: {
      public_access: {
        type: 'boolean',
        description: 'Allow unauthenticated access to /stats endpoint',
        default: false,
      },
    },
  },
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
        description: 'Task execution timeout in seconds',
        default: 300,
        min: 30,
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
    },
  },
  provisioning: {
    description: 'Zone provisioning configuration',
    requires_restart: true,
    properties: {
      install_tools: {
        type: 'boolean',
        description: 'Auto-install required tools (Ansible, rsync, git, dhcpd) on startup',
        default: true,
      },
      staging_path: {
        type: 'string',
        description: 'Path for provisioning staging files',
        default: '/var/lib/zoneweaver-agent/provisioning',
      },
    },
  },
  cleanup: {
    description: 'Database cleanup service configuration',
    requires_restart: false,
    properties: {
      interval: {
        type: 'integer',
        description: 'Cleanup cycle interval in seconds',
        default: 300,
        min: 60,
      },
    },
  },
  vnc: {
    description: 'VNC console configuration',
    requires_restart: true,
    properties: {
      web_port_range_start: {
        type: 'integer',
        description: 'Starting port for noVNC web interfaces',
        default: 8000,
        min: 1024,
        max: 65535,
      },
      web_port_range_end: {
        type: 'integer',
        description: 'Ending port for noVNC web interfaces',
        default: 8100,
        min: 1024,
        max: 65535,
      },
      session_timeout: {
        type: 'integer',
        description: 'VNC session timeout in seconds',
        default: 1800,
        min: 60,
      },
      cleanup_interval: {
        type: 'integer',
        description: 'VNC session cleanup interval in seconds',
        default: 300,
        min: 60,
      },
      bind_address: {
        type: 'string',
        description: 'Bind address for VNC servers',
        default: '127.0.0.1',
      },
      max_concurrent_sessions: {
        type: 'integer',
        description: 'Maximum concurrent VNC sessions',
        default: 10,
        min: 1,
        max: 100,
      },
    },
  },
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
    },
  },
  artifact_storage: {
    description: 'Artifact storage configuration for ISOs and VM images',
    requires_restart: false,
    properties: {
      enabled: { type: 'boolean', description: 'Enable artifact storage', default: true },
    },
  },
  template_sources: {
    description: 'Template source registry configuration',
    requires_restart: false,
    properties: {
      enabled: { type: 'boolean', description: 'Enable template sources', default: true },
      local_storage_path: {
        type: 'string',
        description: 'ZFS dataset path for local templates',
        default: 'rpool/templates',
      },
    },
  },
  updates: {
    description: 'Application update checking configuration',
    requires_restart: false,
    properties: {
      versioninfo_url: {
        type: 'string',
        description: 'URL to remote versioninfo.json for update checking',
        default: '',
      },
      check_interval: {
        type: 'integer',
        description: 'Automatic update check interval in seconds (0 to disable)',
        default: 0,
        min: 0,
      },
    },
  },
};
