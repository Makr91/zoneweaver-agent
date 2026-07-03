/**
 * @fileoverview Zoneweaver Agent - Main application entry point
 * @description Express.js server for managing Bhyve virtual machines on OmniOS with API key authentication
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import express from 'express';
import http from 'http';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { WebSocketServer } from 'ws';

import config from './config/ConfigLoader.js';
import { log, morganMiddleware } from './lib/Logger.js';
import DatabaseMigrations from './config/DatabaseMigrations.js';
import router from './routes/index.js';
import { specs, swaggerUi } from './config/swagger.js';
import { startTaskProcessor } from './controllers/TaskQueue/index.js';
import { startVncSessionCleanup } from './controllers/VncConsoleController/index.js';
import { getZloginCleanupTask } from './controllers/ZloginController.js';
import { getSSHCleanupTask, startSSHSessionCleanup } from './controllers/SSHTerminalController.js';
import { cleanupLogStreamSessions } from './controllers/LogStreamController.js';
import CleanupService from './controllers/CleanupService.js';
import { startHostMonitoring } from './controllers/HostMonitoringService.js';
import { checkAndInstallPackages } from './controllers/ProvisioningController.js';
import ReconciliationService from './controllers/ReconciliationService.js';
import {
  initializeArtifactStorage,
  startArtifactStorage,
} from './controllers/ArtifactStorageService.js';
import { handleWebSocketUpgrade } from './lib/WebSocketHandler.js';
import { setupHTTPSServer } from './lib/SSLManager.js';
import { installShutdownHandlers } from './lib/Shutdown.js';
import { setupSwaggerDocs } from './lib/SwaggerManager.js';
import { startZoneOrchestration } from './controllers/ZoneOrchestrationService.js';
import Tasks from './models/TaskModel.js';
import Entities from './models/EntityModel.js';
import { getOrGenerateSetupToken } from './lib/SetupToken.js';

/**
 * Express application instance
 * @type {import('express').Application}
 */
const app = express();

/**
 * Configuration objects loaded from config.yaml
 */
const serverConfig = config.getServer();
const sslConfig = config.getSSL();
const corsConfig = config.getCORS() || {};

/**
 * Server port configuration
 */
const httpPort = serverConfig.http_port;
const httpsPort = serverConfig.https_port;

/**
 * CORS configuration options
 * @description This is an API-key-authenticated backend in a many-to-many mesh:
 *   any number of Zoneweaver front-ends proxy to any number of these backends,
 *   each authenticating with a per-backend API key. The API key — not the browser
 *   Origin — is the access boundary, so by default the API does not gate on Origin
 *   (`cors.allow_all`, default true). This avoids having to enumerate every
 *   front-end origin in every backend's config. Set `cors.allow_all: false` to
 *   fall back to the explicit `cors.whitelist` and lock down direct browser
 *   access; proxied, API-key-authenticated calls are unaffected either way.
 */
const corsAllowAll = corsConfig.allow_all !== false;
const corsWhitelist = corsConfig.whitelist || [];
const corsOptions = {
  origin(origin, callback) {
    if (corsAllowAll || !origin || corsWhitelist.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      // Decline (omit Access-Control-Allow-Origin) rather than throw — a thrown
      // error has no handler here and would surface as a bare HTTP 500.
      log.app.warn('CORS: origin not allowed', { origin });
      callback(null, false);
    }
  },
  credentials: true,
  preflightContinue: true,
};

/**
 * Express middleware configuration
 * @description Sets up cookie parsing, CORS, JSON parsing, and API documentation
 */
app.use(cookieParser());
app.use(cors(corsOptions));
app.options('/*splat', cors(corsOptions));

const artifactConfig = config.getArtifactStorage?.() || {};
const maxUploadGB = artifactConfig.security?.max_upload_size_gb || 50;
const maxUploadSize = `${maxUploadGB}gb`;

app.set('trust proxy', 1);
app.use(express.json({ limit: maxUploadSize }));
app.use(express.urlencoded({ limit: maxUploadSize, extended: true }));
app.use(morganMiddleware);

/**
 * API routes
 * @description Mounts all API endpoints from routes/index.js
 */
app.use(router);

/**
 * Setup Swagger API Documentation
 */
setupSwaggerDocs(app, config.getApiDocs(), specs, swaggerUi);

/**
 * HTTP server instance
 * @type {import('http').Server}
 */
const httpServer = http.createServer(app);

/**
 * WebSocket server for handling VNC connections
 * @description Uses ws library WebSocket server for proper protocol handling
 */
const wss = new WebSocketServer({ noServer: true });

// Add WebSocket upgrade handler to HTTP server
httpServer.on('upgrade', (request, socket, head) => {
  handleWebSocketUpgrade(request, socket, head, wss);
});

/**
 * Setup HTTPS server
 */
const httpsServer = setupHTTPSServer(
  app,
  sslConfig,
  httpsPort,
  serverConfig,
  handleWebSocketUpgrade,
  wss
);

/**
 * Install graceful shutdown handlers
 * @description On SIGTERM/SIGINT, stop background work producers, close the HTTP,
 *   HTTPS and WebSocket servers, and close the database cleanly before exiting.
 *   A watchdog guarantees the process exits even if a close step stalls, so it can
 *   never hang the SMF `:kill` stop method.
 */
installShutdownHandlers({ httpServer, httpsServer, wss });

/**
 * Start HTTP server
 * @description Starts the HTTP server and logs startup information
 */
httpServer.listen(httpPort, () => {
  // Start background services after server is running

  // Initialize database schema and run migrations
  DatabaseMigrations.setupDatabase()
    .then(async success => {
      if (success) {
        // Clear any pending/running tasks from previous server runs
        try {
          const clearedTasks = await Tasks.update(
            { status: 'cancelled' },
            {
              where: {
                status: ['pending', 'running'],
              },
            }
          );
          if (clearedTasks[0] > 0) {
            log.app.info('Cleared pending tasks from previous startup', {
              cleared_count: clearedTasks[0],
            });
          }
        } catch (error) {
          log.app.warn('Failed to clear tasks on startup', {
            error: error.message,
          });
        }

        // First-boot claim token: if the agent can still be bootstrapped (no keys yet),
        // ensure the setup token exists and print it so a host admin can read it. It
        // guards POST /api-keys/bootstrap (see SetupToken.js). No-op once a key exists.
        try {
          const apiKeyConfig = config.getApiKeys() || {};
          if (
            apiKeyConfig.bootstrap_enabled &&
            apiKeyConfig.bootstrap_require_claim_token !== false
          ) {
            const entityCount = await Entities.count();
            if (entityCount === 0) {
              const token = getOrGenerateSetupToken();
              if (token) {
                log.auth.info(`Setup token (required to create the first API key): ${token}`);
              }
            }
          }
        } catch (error) {
          log.auth.warn('Failed to prepare setup token', { error: error.message });
        }

        // Check and install required packages
        await checkAndInstallPackages();

        // Start task processor for zone operations
        startTaskProcessor();

        // Start VNC session cleanup
        startVncSessionCleanup();

        // Clean up stale SSH sessions from previous server run
        await startSSHSessionCleanup();

        // Register cleanup tasks
        CleanupService.registerTask(getZloginCleanupTask());
        CleanupService.registerTask(getSSHCleanupTask());
        CleanupService.registerTask({
          name: 'log_stream_cleanup',
          description: 'Clean up old log streaming session records',
          handler: cleanupLogStreamSessions,
        });

        // Start cleanup service
        CleanupService.start();

        // Start host monitoring service
        startHostMonitoring();

        // Start reconciliation service
        ReconciliationService.start();

        // Initialize and start artifact storage service
        await initializeArtifactStorage();
        await startArtifactStorage();

        // Start zone orchestration service
        await startZoneOrchestration();

        log.app.info('Zoneweaver Agent fully initialized and ready for zone management', {
          services_started: [
            'task_processor',
            'vnc_session_cleanup',
            'cleanup_service',
            'host_monitoring',
            'reconciliation_service',
            'artifact_storage_service',
          ],
          startup_actions_completed: [
            config.getZoneOrchestration().enabled ? 'zone_orchestration_startup' : null,
          ].filter(Boolean),
          zone_orchestration_enabled: config.getZoneOrchestration().enabled,
          ready: true,
        });
      } else {
        log.app.error('Database setup failed - some features may not work correctly');
      }
    })
    .catch(error => {
      log.app.error('Database setup error', {
        error: error.message,
        stack: error.stack,
      });
    });
});
