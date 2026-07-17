/**
 * @fileoverview Settings schema — artifact/template storage and updates sections
 * @description artifact_storage, template_sources, updates. Field shape and
 * `default` semantics per SettingsSchema.js (the aggregating index).
 */

export const STORAGE_SCHEMA = {
  artifact_storage: {
    description: 'Artifact storage configuration for ISOs and VM images',
    requires_restart: false,
    properties: {
      enabled: { type: 'boolean', description: 'Enable artifact storage', default: true },
      download: {
        type: 'object',
        description: 'URL download behavior',
        properties: {
          timeout_seconds: {
            type: 'integer',
            description: 'Download timeout in seconds',
            default: 1500,
            min: 60,
          },
          progress_update_seconds: {
            type: 'integer',
            description: 'Progress update interval in seconds',
            default: 10,
            min: 1,
          },
        },
      },
      checksums: {
        type: 'object',
        description: 'Checksum calculation',
        properties: {
          enabled: { type: 'boolean', description: 'Calculate artifact checksums', default: true },
          algorithm: {
            type: 'string',
            description: 'Checksum algorithm',
            default: 'sha256',
            enum: ['md5', 'sha1', 'sha256', 'sha512'],
          },
          detect_duplicates: {
            type: 'boolean',
            description: 'Detect duplicate artifacts by checksum',
            default: true,
          },
          skip_duplicate_uploads: {
            type: 'boolean',
            description: 'Reject uploads whose checksum already exists',
            default: false,
          },
        },
      },
      scanning: {
        type: 'object',
        description: 'Filesystem scanning',
        properties: {
          auto_scan_after_upload: {
            type: 'boolean',
            description: 'Scan storage after uploads',
            default: true,
          },
          auto_scan_after_download: {
            type: 'boolean',
            description: 'Scan storage after downloads',
            default: true,
          },
          periodic_scan_interval: {
            type: 'integer',
            description: 'Periodic scan interval in seconds (0 to disable)',
            default: 300,
            min: 0,
          },
          supported_extensions: {
            type: 'object',
            description: 'Recognized artifact extensions by type',
            properties: {
              iso: {
                type: 'array',
                items: 'string',
                description: 'ISO extensions',
                default: ['.iso'],
              },
              image: {
                type: 'array',
                items: 'string',
                description: 'VM image extensions',
                default: ['.vmdk', '.raw', '.vdi', '.qcow2', '.img', '.ova', '.ovf'],
              },
            },
          },
        },
      },
      paths: {
        type: 'array',
        items: 'object',
        description:
          'Storage path entries ({name, path, type: iso|image, enabled}); managed via /artifacts/storage/paths',
        default: [],
      },
      security: {
        type: 'object',
        description: 'Transfer limits',
        properties: {
          max_download_size_gb: {
            type: 'integer',
            description: 'Maximum download size in GB',
            default: 50,
            min: 1,
          },
          download_timeout_minutes: {
            type: 'integer',
            description: 'Download timeout in minutes',
            default: 60,
            min: 1,
          },
          max_upload_size_gb: {
            type: 'integer',
            description: 'Maximum upload size in GB',
            default: 50,
            min: 1,
          },
          upload_timeout_minutes: {
            type: 'integer',
            description: 'Upload timeout in minutes',
            default: 120,
            min: 1,
          },
          max_form_field_size_mb: {
            type: 'integer',
            description: 'Maximum multipart form field size in MB',
            default: 10,
            min: 1,
          },
          max_files_per_upload: {
            type: 'integer',
            description: 'Maximum files per upload request',
            default: 1,
            min: 1,
          },
          max_form_fields: {
            type: 'integer',
            description: 'Maximum multipart form fields',
            default: 10,
            min: 1,
          },
          upload_session_timeout_hours: {
            type: 'integer',
            description: 'Prepared upload session timeout in hours',
            default: 2,
            min: 1,
          },
        },
      },
      cleanup: {
        type: 'object',
        description: 'Cleanup and retention',
        properties: {
          enabled: { type: 'boolean', description: 'Enable artifact cleanup', default: true },
          orphaned_files_retention_days: {
            type: 'integer',
            description: 'Days to keep orphaned artifact records',
            default: 30,
            min: 1,
          },
          failed_downloads_cleanup: {
            type: 'boolean',
            description: 'Remove partial files from failed downloads',
            default: true,
          },
        },
      },
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
      sources: {
        type: 'array',
        items: 'object',
        description:
          'Registry sources ({name, url, auth_token, enabled, default, ca_file}) — auth_token is a raw registry service-account token (Bearer, the ONLY registry credential); ca_file joins a self-signed registry CA to the trust store (verification always on)',
        default: [],
      },
      download: {
        type: 'object',
        description: 'Template download behavior',
        properties: {
          timeout_seconds: {
            type: 'integer',
            description: 'Download timeout in seconds',
            default: 3600,
            min: 60,
          },
          max_download_size_gb: {
            type: 'integer',
            description: 'Maximum template download size in GB',
            default: 100,
            min: 1,
          },
        },
      },
      upload: {
        type: 'object',
        description: 'Template publish behavior',
        properties: {
          timeout_seconds: {
            type: 'integer',
            description: 'Upload timeout in seconds',
            default: 7200,
            min: 60,
          },
          chunk_size_mb: {
            type: 'integer',
            description: 'Upload chunk size in MB',
            default: 100,
            min: 1,
          },
        },
      },
    },
  },
  updates: {
    description: 'Application update checking configuration',
    requires_restart: false,
    properties: {
      versioninfo_url: {
        type: 'string',
        description: 'URL to the remote update-info JSON for update checking',
        default:
          'https://github.com/Makr91/zoneweaver-agent/releases/latest/download/update-info.json',
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
