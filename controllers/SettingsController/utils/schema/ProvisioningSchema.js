/**
 * @fileoverview Settings schema — provisioning and console sections
 * @description provisioning, cleanup, vnc. Field shape and `default` semantics
 * per SettingsSchema.js (the aggregating index).
 */

export const PROVISIONING_SCHEMA = {
  snapshots: {
    description: 'Scheduled zone snapshot rotation (Snapshoter.sh semantics, in-agent)',
    requires_restart: true,
    properties: {
      enabled: {
        type: 'boolean',
        description: 'Run the snapshot rotation service',
        default: false,
      },
      interval_minutes: {
        type: 'integer',
        description:
          'Cadence for simple/age default policies (rotation uses the fixed hourly/daily/weekly schedule)',
        default: 60,
        min: 5,
      },
      default_policy: {
        type: 'object',
        description:
          'Retention policy applied to EVERY zone unless the zone overrides it (configuration.snapshots; type none disables per zone). Types: none | simple (keep newest N) | age (delete older than max_age_days) | rotation (hourly/daily/weekly tiers, Snapshoter.sh schedule). Deletions are always skipped while the pool scrubs/resilvers. quiesce runs qga fsfreeze around each snapshot when the guest agent answers.',
        properties: {
          type: {
            type: 'string',
            description: 'Retention type',
            default: 'none',
            enum: ['none', 'simple', 'age', 'rotation'],
          },
          quiesce: {
            type: 'boolean',
            description: 'qga fsfreeze around snapshots (application-consistent when available)',
            default: false,
          },
          keep: {
            type: 'integer',
            description: 'simple: newest N auto snapshots to keep',
            default: 24,
            min: 1,
          },
          max_age_days: {
            type: 'integer',
            description: 'age: delete auto snapshots older than this',
            default: 14,
            min: 1,
          },
          tiers: {
            type: 'object',
            description:
              'rotation: per-tier keep counts — hourly (:00, hours 1-23), daily (00:00 Sun-Fri), weekly (00:00 Sat)',
            properties: {
              hourly: {
                type: 'object',
                description: 'Hourly tier',
                properties: {
                  keep: { type: 'integer', description: 'Snapshots to keep', default: 24, min: 1 },
                },
              },
              daily: {
                type: 'object',
                description: 'Daily tier',
                properties: {
                  keep: { type: 'integer', description: 'Snapshots to keep', default: 8, min: 1 },
                },
              },
              weekly: {
                type: 'object',
                description: 'Weekly tier',
                properties: {
                  keep: { type: 'integer', description: 'Snapshots to keep', default: 5, min: 1 },
                },
              },
            },
          },
        },
      },
    },
  },
  guest_agent: {
    description: 'QEMU guest-agent channel (virtio-console qga socket)',
    requires_restart: true,
    properties: {
      enabled: {
        type: 'boolean',
        description:
          'Master switch for the guest-agent surface (/machines/{name}/guest/*, discovery probe, and the per-machine zones.guest_agent create option). Windows guests need the r151054az bhyve virtio-console fix and hostbridge=q35.',
        default: false,
      },
    },
  },
  provisioning: {
    description: 'Zone provisioning configuration',
    requires_restart: true,
    properties: {
      staging_path: {
        type: 'string',
        description: 'Path for provisioning staging files',
        default: '/var/lib/zoneweaver-agent/provisioning',
      },
      provisioners_path: {
        type: 'string',
        description: 'Provisioner package registry directory (SHI on-disk format)',
        default: '/var/lib/zoneweaver-agent/provisioners',
      },
      playbook_timeout_seconds: {
        type: 'integer',
        description: 'Timeout for a single Ansible playbook run',
        default: 21600,
        min: 60,
      },
      ansible_install_timeout_seconds: {
        type: 'integer',
        description: 'Timeout for Ansible tool installation',
        default: 300,
        min: 60,
      },
      shell_script_timeout_seconds: {
        type: 'integer',
        description: 'Timeout for a single provisioning shell script or sequence hook run',
        default: 1800,
        min: 60,
      },
      docker_timeout_seconds: {
        type: 'integer',
        description: 'Timeout for a docker/docker_compose provisioning step',
        default: 3600,
        min: 60,
      },
      host_hooks: {
        type: 'boolean',
        description:
          'Allow host-target sequence hooks (provisioning.pre/post entries with target: host) to run ON THIS AGENT HOST. Default OFF — zoneweaver hosts are typically shared; documents carrying host hooks are refused pre-flight while off.',
        default: false,
      },
      default_network_interface: {
        type: 'string',
        description:
          'Value injected into the packaged-create render context as settings.default_network_interface when the request carries none (the ruled two-injection set, shared with the Go agent). Empty = inject nothing meaningful (absent keys render empty).',
        default: '',
      },
      catalog_sources: {
        type: 'object',
        description:
          'Public provisioner catalogs (the HACS model) — mirrors the template-sources pattern',
        properties: {
          enabled: {
            type: 'boolean',
            description: 'Enable catalog fetching/import',
            default: true,
          },
          sources: {
            type: 'array',
            items: 'object',
            description:
              'Catalog entries ({name, url, enabled, default, ca_file}) — url serves catalog.json (format_version 1); ca_file joins a forked self-hosted catalog’s CA to the trust store (verification never off). When EMPTY, the built-in STARTcloud catalog (https://provisioner-catalog.startcloud.com/catalog.json) serves as the default.',
            default: [],
          },
          download_timeout_seconds: {
            type: 'integer',
            description: 'Timeout for a catalog artifact download',
            default: 600,
            min: 30,
          },
        },
      },
      ssh: {
        type: 'object',
        description: 'Provisioning SSH access',
        properties: {
          key_path: {
            type: 'string',
            description: 'Default SSH private key for provisioning connections',
            default: '/etc/zoneweaver-agent/ssh/provision_key',
          },
          timeout_seconds: {
            type: 'integer',
            description: 'Total wait for SSH to become available',
            default: 300,
            min: 10,
          },
          poll_interval_seconds: {
            type: 'integer',
            description: 'Interval between SSH availability checks',
            default: 10,
            min: 1,
          },
        },
      },
      network: {
        type: 'object',
        description: 'Dedicated provisioning network (etherstub + DHCP)',
        properties: {
          enabled: {
            type: 'boolean',
            description: 'Enable the provisioning network',
            default: true,
          },
          etherstub_name: {
            type: 'string',
            description: 'Etherstub name for the provisioning network',
            default: 'estub_provision',
          },
          host_vnic_name: {
            type: 'string',
            description: 'Host-side VNIC name on the provisioning network',
            default: 'provision_interconnect0',
          },
          subnet: {
            type: 'string',
            description: 'Provisioning network subnet (CIDR)',
            default: '10.190.190.0/24',
          },
          host_ip: {
            type: 'string',
            description: 'Host IP on the provisioning network',
            default: '10.190.190.1',
          },
          netmask: {
            type: 'string',
            description: 'Provisioning network netmask',
            default: '255.255.255.0',
          },
          dhcp_range_start: {
            type: 'string',
            description: 'First DHCP-assignable provisioning IP',
            default: '10.190.190.10',
          },
          dhcp_range_end: {
            type: 'string',
            description: 'Last DHCP-assignable provisioning IP',
            default: '10.190.190.254',
          },
        },
      },
      task_output: {
        type: 'object',
        description: 'Task output capture and persistence',
        properties: {
          enabled: { type: 'boolean', description: 'Capture task output', default: true },
          mode: {
            type: 'string',
            description: 'Capture mode',
            default: 'full',
            enum: ['full', 'circular'],
          },
          circular_max_lines: {
            type: 'integer',
            description: 'Line cap in circular mode',
            default: 10000,
            min: 100,
          },
          flush_interval_seconds: {
            type: 'integer',
            description: 'Debounced output flush interval to the database',
            default: 10,
            min: 1,
          },
          persist_log_file: {
            type: 'boolean',
            description: 'Also write task output to a per-task log file',
            default: true,
          },
          log_directory: {
            type: 'string',
            description: 'Directory for per-task log files',
            default: '/var/log/zoneweaver-agent/tasks',
          },
        },
      },
      zlogin: {
        type: 'object',
        description: 'zlogin recipe automation',
        properties: {
          enabled: { type: 'boolean', description: 'Enable zlogin automation', default: true },
          default_timeout_seconds: {
            type: 'integer',
            description: 'Default recipe execution timeout',
            default: 300,
            min: 30,
          },
          max_concurrent_automations: {
            type: 'integer',
            description: 'Maximum concurrent zlogin automations',
            default: 3,
            min: 1,
          },
        },
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
};
