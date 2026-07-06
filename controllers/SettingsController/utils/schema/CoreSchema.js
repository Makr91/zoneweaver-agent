/**
 * @fileoverview Settings schema — core serving sections
 * @description server, ssl, cors, database, api_keys, stats. Field shape and
 * `default` semantics per SettingsSchema.js (the aggregating index).
 */

export const CORE_SCHEMA = {
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
      enabled: {
        type: 'boolean',
        description:
          'Enable HTTPS — with certificates loaded, the HTTP port serves only 308 redirects to the HTTPS port unless force_secure is false (full app stays on HTTP only if certificates fail to load)',
        default: true,
      },
      force_secure: {
        type: 'boolean',
        description:
          'With SSL enabled and certificates loaded, serve only 308 redirects on the HTTP port. Set false to dual-serve the full app on HTTP alongside HTTPS (escape hatch)',
        default: true,
      },
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
      allow_all: {
        type: 'boolean',
        description:
          'Accept any Origin (API key is the access boundary). Set false to enforce the whitelist for direct browser access',
        default: true,
      },
      whitelist: {
        type: 'array',
        items: 'string',
        description: 'Allowed origins for CORS requests when allow_all is false',
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
      directory: {
        type: 'string',
        description:
          'Directory holding the per-datatype SQLite files (core.sqlite, metrics-network.sqlite, metrics-storage.sqlite, metrics-system.sqlite)',
        default: '/var/lib/zoneweaver-agent/database',
      },
      logging: { type: 'boolean', description: 'Enable SQL query logging', default: false },
      sqlite_options: {
        type: 'object',
        description:
          'SQLite performance tuning applied to every database file (pragmas, pool, busy retry)',
        properties: {
          journal_mode: {
            type: 'string',
            description: 'SQLite journal mode',
            default: 'WAL',
            enum: ['WAL', 'DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'OFF'],
          },
          synchronous: {
            type: 'string',
            description: 'SQLite synchronous pragma',
            default: 'NORMAL',
            enum: ['OFF', 'NORMAL', 'FULL', 'EXTRA'],
          },
          cache_size_mb: {
            type: 'integer',
            description: 'Page cache size in MB',
            default: 128,
            min: 1,
          },
          temp_store: {
            type: 'string',
            description: 'Temporary table storage location',
            default: 'MEMORY',
            enum: ['DEFAULT', 'FILE', 'MEMORY'],
          },
          mmap_size_mb: {
            type: 'integer',
            description: 'Memory-mapped I/O size in MB',
            default: 512,
            min: 0,
          },
          busy_timeout_ms: {
            type: 'integer',
            description: 'Milliseconds to wait on a locked database',
            default: 30000,
            min: 0,
          },
          wal_autocheckpoint: {
            type: 'integer',
            description: 'WAL auto-checkpoint interval in pages',
            default: 1000,
            min: 0,
          },
          optimize: {
            type: 'boolean',
            description: 'Run PRAGMA optimize on connection',
            default: true,
          },
          pool: {
            type: 'object',
            description: 'Sequelize connection pool',
            properties: {
              max: {
                type: 'integer',
                description: 'Maximum pool connections',
                default: 10,
                min: 1,
              },
              min: { type: 'integer', description: 'Minimum pool connections', default: 2, min: 0 },
              acquire_timeout_ms: {
                type: 'integer',
                description: 'Timeout to acquire a connection (ms)',
                default: 60000,
                min: 1000,
              },
              idle_timeout_ms: {
                type: 'integer',
                description: 'Idle connection timeout (ms)',
                default: 30000,
                min: 1000,
              },
              evict_interval_ms: {
                type: 'integer',
                description: 'Idle connection eviction check interval (ms)',
                default: 5000,
                min: 100,
              },
            },
          },
          retry: {
            type: 'object',
            description: 'Retry behavior on SQLITE_BUSY/SQLITE_LOCKED',
            properties: {
              max_retries: {
                type: 'integer',
                description: 'Maximum retries on a busy database',
                default: 5,
                min: 0,
              },
              backoff_base_ms: {
                type: 'integer',
                description: 'Retry backoff base (ms)',
                default: 100,
                min: 1,
              },
              backoff_exponent: {
                type: 'number',
                description: 'Retry backoff exponent',
                default: 1.5,
                min: 1,
              },
            },
          },
        },
      },
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
      bootstrap_require_claim_token: {
        type: 'boolean',
        description: 'Require the setup claim token (file beside config.yaml) to bootstrap',
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
};
