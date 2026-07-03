/**
 * @fileoverview Swagger Documentation Manager for Zoneweaver Agent
 * @description Handles API documentation setup and configuration
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import fs from 'fs';

import { log } from './Logger.js';

// Dark Swagger theme shared with the Hyperweaver UI + docs site (config/swagger-theme.css).
// Read once at module load; injected as swagger-ui-express customCss.
const swaggerCustomCss = fs.readFileSync(
  new URL('../config/swagger-theme.css', import.meta.url),
  'utf8'
);

/**
 * Build the spec with a request-aware `servers` block so "Try it out" targets
 * whoever served the page (auto-detected), with a custom-server fallback.
 * @param {import('express').Request} req - Express request
 * @param {Object} specs - Base swagger-jsdoc spec
 * @returns {Object} Spec with a dynamic servers block
 */
const withDynamicServers = (req, specs) => ({
  ...specs,
  servers: [
    {
      url: `${req.protocol}://${req.get('host')}`,
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
});

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

  // Public OpenAPI spec — registered BEFORE the UI mount so it always returns JSON
  // (never shadowed by the swagger-ui page handler). Served same-origin for the UI
  // below, and fetched server-side by the Hyperweaver Server to render this agent's
  // API at /agent/api-docs (aggregated mode) with no browser cross-origin call.
  app.get('/api-docs/swagger.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(withDynamicServers(req, specs));
  });

  // The interactive, dark-themed Swagger UI; spec loaded from /api-docs/swagger.json.
  app.use('/api-docs', swaggerUi.serve, (req, res, next) => {
    swaggerUi.setup(withDynamicServers(req, specs), {
      explorer: true,
      customCss: swaggerCustomCss,
      customSiteTitle: 'Zoneweaver Agent Documentation',
      swaggerOptions: {
        url: `${req.protocol}://${req.get('host')}/api-docs/swagger.json`,
      },
    })(req, res, next);
  });
};
