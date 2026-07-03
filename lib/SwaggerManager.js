/**
 * @fileoverview Swagger Documentation Manager for Zoneweaver Agent
 * @description Handles API documentation setup and configuration
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { log } from './Logger.js';

/**
 * Setup Swagger API documentation middleware
 * @param {Object} app - Express application instance
 * @param {Object} apiDocsConfig - API docs configuration
 * @param {Object} specs - Swagger specifications
 * @param {Object} swaggerUi - Swagger UI middleware
 * @returns {void}
 */
export const setupSwaggerDocs = (app, apiDocsConfig, specs, swaggerUi) => {
  if (!apiDocsConfig?.enabled) {
    log.app.info('API documentation endpoint disabled by configuration', {
      enabled: false,
    });
    return;
  }

  log.app.info('API documentation endpoint enabled', {
    endpoint: '/api-docs',
    enabled: true,
  });

  app.use('/api-docs', swaggerUi.serve, (req, res, next) => {
    // Dynamically set the server URL based on the current request
    const { protocol } = req;
    const host = req.get('host');
    const dynamicSpecs = {
      ...specs,
      servers: [
        {
          url: `${protocol}://${host}`,
          description: 'Current server (auto-detected)',
        },
        {
          url: '{protocol}://{host}',
          description: 'Custom server',
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
    };

    swaggerUi.setup(dynamicSpecs, {
      explorer: true,
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'Zoneweaver Agent Documentation',
    })(req, res, next);
  });
};
