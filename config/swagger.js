import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Agent API',
      // Agent API CONTRACT version (architecture D1) — frozen at the v1 line,
      // deliberately NOT release-please-stamped. Both host-agents (zoneweaver-agent
      // Node/Bhyve and hyperweaver-agent Go/VirtualBox) implement this contract.
      version: '1.0.0',
      'x-app-version': '0.3.8', // x-release-please-version
      description:
        'Hyperweaver Agent API v1 — the shared host-agent contract (architecture D1). ' +
        'Reference implementation: zoneweaver-agent (Bhyve/OmniOS, Node). ' +
        'The canonical resource noun is `machines` (O1) — machine-scoped routes are ' +
        'served at /machines/* only. ' +
        'Capabilities are advertised by the public GET /api/status ' +
        '(role, hypervisors, console, auth, features) and drive conditional UI rendering. ' +
        'The implementing application version is `info.x-app-version`.' +
        '\n\n## Response envelopes\n' +
        'Direct (synchronous) success responses are wrapped by the DirectSuccessEnvelope ' +
        '(`success`, `message`, `timestamp`) and async-task 202 responses by the ' +
        'TaskCreatedEnvelope (`success`, `message`, `task_id`, `status`, `created_at`) — ' +
        'see the component schemas. Endpoint-specific fields are spread at the TOP LEVEL ' +
        'alongside the envelope fields; per-endpoint response schemas that document only ' +
        'their data fields implicitly include the envelope. Errors from these surfaces use ' +
        'the ErrorEnvelope (`success:false`, `error`, `timestamp`, optional `details`).\n\n' +
        '## Authorization role model (direct mode)\n' +
        'Every authenticated endpoint enforces the Agent API v1 role hierarchy ' +
        'viewer < operator < admin via a central method+path policy (not repeated per ' +
        'endpoint): `/api-keys/info` = any valid key; `/api-keys/*` and `/settings/*` = ' +
        'admin (all methods); `/ws-ticket` and `/filesystem/*` = operator (all methods); ' +
        'other GET/HEAD = viewer; other mutations = operator, except mutations under ' +
        '`/server`, `/system/host`, `/system/users`, `/system/groups`, `/system/roles`, ' +
        '`/database` = admin. An insufficient role returns ' +
        '`403 {"msg": "Insufficient role: ..."}` on ANY endpoint. Authentication itself: ' +
        'missing key = 401, invalid key = 403. Keys are sent as `Authorization: Bearer ' +
        '<key>` or `X-API-Key: <key>`.\n\n' +
        '## Config-gated surfaces\n' +
        'Surfaces with a configuration kill-switch return `503 {"error": "... disabled in ' +
        'configuration"}` on every endpoint when their config block is disabled: ' +
        'fault-management (`fault_management.enabled`), syslog + system logs + log ' +
        'streaming (`system_logs.enabled`), file browser (`file_browser.enabled`), ' +
        'artifacts (`artifact_storage.enabled`), templates (`template_sources.enabled`). ' +
        'The matching capability token is absent from GET /api/status in that state — ' +
        'clients gating on tokens never hit these 503s.',
      license: {
        name: 'GPL-3.0',
        url: 'https://zoneweaver-agent.startcloud.com/license/',
      },
      contact: {
        name: 'Zoneweaver Agent',
        url: 'https://zoneweaver-agent.startcloud.com',
      },
    },
    externalDocs: {
      description: 'View on GitHub',
      url: 'https://github.com/Makr91/zoneweaver-agent',
    },
    servers: [
      {
        url: '{protocol}://{host}',
        description: 'Current server',
        variables: {
          protocol: {
            enum: ['http', 'https'],
            default: 'https',
            description: 'The protocol used to access the server',
          },
          host: {
            default: 'localhost:5001',
            description: 'The hostname and port of the server',
          },
        },
      },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'API Key',
          description:
            'API key authentication using Bearer token format. Use format: Bearer wh_your_api_key_here',
        },
      },
      schemas: {
        ApiKey: {
          type: 'object',
          properties: {
            api_key: {
              type: 'string',
              description: 'Generated API key with wh_ prefix',
              example: 'wh_abc123def456...',
            },
            entity_id: {
              type: 'integer',
              description: 'Unique identifier for the entity',
              example: 1,
            },
            name: {
              type: 'string',
              description: 'Human-readable name for the API key',
              example: 'Zoneweaver-Production',
            },
            description: {
              type: 'string',
              description: 'Optional description of the API key purpose',
              example: 'API key for Zoneweaverfrontend',
            },
            role: {
              type: 'string',
              enum: ['admin', 'operator', 'viewer'],
              description: 'Authorization role of the key (Agent API v1 role model)',
              example: 'admin',
            },
            message: {
              type: 'string',
              description: 'Success message',
              example: 'API key generated successfully',
            },
          },
        },
        Entity: {
          type: 'object',
          properties: {
            id: {
              type: 'integer',
              description: 'Unique identifier',
              example: 1,
            },
            name: {
              type: 'string',
              description: 'Entity name',
              example: 'Zoneweaver-Production',
            },
            description: {
              type: 'string',
              description: 'Entity description',
              example: 'API key for Zoneweaverfrontend',
            },
            role: {
              type: 'string',
              enum: ['admin', 'operator', 'viewer'],
              description: 'Authorization role of the key (Agent API v1 role model)',
              example: 'admin',
            },
            is_active: {
              type: 'boolean',
              description: 'Whether the API key is active',
              example: true,
            },
            created_at: {
              type: 'string',
              format: 'date-time',
              description: 'Creation timestamp',
              example: '2025-06-08T17:18:00.324Z',
            },
            last_used: {
              type: 'string',
              format: 'date-time',
              description: 'Last usage timestamp',
              example: '2025-06-08T17:19:19.921Z',
            },
          },
        },
        Error: {
          type: 'object',
          properties: {
            msg: {
              type: 'string',
              description: 'Error message',
              example: 'Invalid API key',
            },
          },
        },
        ServerStats: {
          type: 'object',
          properties: {
            hostname: {
              type: 'string',
              description: 'Server hostname',
              example: 'omnios-host-01',
            },
            platform: {
              type: 'string',
              description: 'Operating system platform',
              example: 'sunos',
            },
            arch: {
              type: 'string',
              description: 'System architecture',
              example: 'x64',
            },
            cpus: {
              type: 'array',
              description: 'CPU information',
              items: {
                type: 'object',
              },
            },
            freemem: {
              type: 'integer',
              description: 'Free memory in bytes',
              example: 8589934592,
            },
            totalmem: {
              type: 'integer',
              description: 'Total memory in bytes',
              example: 17179869184,
            },
            uptime: {
              type: 'integer',
              description: 'System uptime in seconds',
              example: 86400,
            },
            allmachines: {
              type: 'array',
              description: 'All configured machines (zoneadm list lines on this agent)',
              items: {
                type: 'string',
              },
              example: [
                'zone1:configured:/zones/zone1:excl:0:uuid1',
                'zone2:running:/zones/zone2:excl:1:uuid2',
              ],
            },
            runningmachines: {
              type: 'array',
              description: 'Currently running machines',
              items: {
                type: 'string',
              },
              example: ['zone2'],
            },
          },
        },
        FileSystemItem: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'File or directory name',
              example: 'document.txt',
            },
            path: {
              type: 'string',
              description: 'Full file path',
              example: '/home/user/document.txt',
            },
            isDirectory: {
              type: 'boolean',
              description: 'Whether this item is a directory',
              example: false,
            },
            size: {
              type: 'integer',
              nullable: true,
              description: 'File size in bytes (null for directories)',
              example: 1024,
            },
            mimeType: {
              type: 'string',
              nullable: true,
              description: 'MIME type of the file',
              example: 'text/plain',
            },
            isBinary: {
              type: 'boolean',
              description: 'Whether the file contains binary data',
              example: false,
            },
            syntax: {
              type: 'string',
              nullable: true,
              description: 'Syntax highlighting type for text files',
              example: 'javascript',
            },
            permissions: {
              type: 'object',
              properties: {
                octal: {
                  type: 'string',
                  description: 'Permissions in octal format',
                  example: '644',
                },
                readable: {
                  type: 'boolean',
                  description: 'File is readable',
                },
                writable: {
                  type: 'boolean',
                  description: 'File is writable',
                },
                executable: {
                  type: 'boolean',
                  description: 'File is executable',
                },
              },
            },
            uid: {
              type: 'integer',
              description: 'File owner user ID',
              example: 1000,
            },
            gid: {
              type: 'integer',
              description: 'File owner group ID',
              example: 1000,
            },
            mtime: {
              type: 'string',
              format: 'date-time',
              description: 'Last modified time',
              example: '2025-06-08T17:19:19.921Z',
            },
            atime: {
              type: 'string',
              format: 'date-time',
              description: 'Last access time',
              example: '2025-06-08T17:19:19.921Z',
            },
            ctime: {
              type: 'string',
              format: 'date-time',
              description: 'Creation/change time',
              example: '2025-06-08T17:19:19.921Z',
            },
          },
        },
      },
    },
    security: [
      {
        ApiKeyAuth: [],
      },
    ],
  },
  apis: ['./controllers/**/*.js', './routes/*.js', './models/*.js'], // paths to files containing OpenAPI definitions
};

const specs = swaggerJsdoc(options);

export { specs, swaggerUi };
