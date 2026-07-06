/**
 * @fileoverview Settings schema — provisioning and console sections
 * @description provisioning, cleanup, vnc. Field shape and `default` semantics
 * per SettingsSchema.js (the aggregating index).
 */

export const PROVISIONING_SCHEMA = {
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
