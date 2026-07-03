import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Zoneweaver Agent',
      version: '0.3.4', // x-release-please-version
      description: 'API for managing Bhyve virtual machines on OmniOS',
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
            allzones: {
              type: 'array',
              description: 'All configured zones',
              items: {
                type: 'string',
              },
              example: [
                'zone1:configured:/zones/zone1:excl:0:uuid1',
                'zone2:running:/zones/zone2:excl:1:uuid2',
              ],
            },
            runningzones: {
              type: 'array',
              description: 'Currently running zones',
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
