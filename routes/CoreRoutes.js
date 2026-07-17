import express from 'express';
import path from 'path';
import config from '../config/ConfigLoader.js';
import { verifyApiKey } from '../middleware/VerifyApiKey.js';
import { serverStats } from '../controllers/ServerStats.js';
import {
  bootstrapFirstApiKey,
  generateApiKey,
  listApiKeys,
  deleteApiKey,
  revokeApiKey,
  getApiKeyInfo,
} from '../controllers/ApiKeys.js';
import { getRoot } from '../controllers/RootController.js';
import { getProvisioningStatus } from '../controllers/ProvisioningController.js';
import {
  getProvisioningNetworkStatus,
  setupProvisioningNetwork,
  teardownProvisioningNetwork,
  getBridgedInterfaces,
} from '../controllers/ProvisioningNetworkController.js';
import {
  listRecipes,
  createRecipe,
  getRecipe,
  updateRecipe,
  deleteRecipe,
  testRecipe,
} from '../controllers/RecipeController.js';
import {
  listProvisioners,
  getProvisionerDetails,
  getProvisionerVersion,
  importProvisioner,
  importProvisionerUpload,
  exportProvisioner,
  deleteProvisioner,
  deleteProvisionerVersion,
  refreshProvisionerSpecs,
  refreshProvisionerFromSource,
  getCatalog,
  getCatalogSources,
  installFromCatalog,
} from '../controllers/ProvisioningOrchestrationController/index.js';
import {
  provisionerUploadSingle,
  handleUploadError as handleProvisionerUploadError,
} from '../middleware/ProvisionerUpload.js';
import {
  getSettings,
  getSettingsSchema,
  updateSettings,
  createConfigBackup,
  listBackups,
  restoreBackup,
  deleteBackup,
  restartServer,
} from '../controllers/SettingsController/index.js';
import { getSecrets, updateSecrets } from '../controllers/SecretsController.js';
import { getVersion, checkForAppUpdates } from '../controllers/VersionController.js';
import { getStatus } from '../controllers/StatusController.js';
import { getTicketConfig } from '../controllers/TicketConfigController.js';
import { getWsTicket } from '../controllers/WsTicketController.js';

/**
 * @fileoverview Core routes — provisioning orchestration, version, UI/docs
 * shims, public identity/bootstrap, API keys, WS tickets, settings.
 */

/**
 * Register the provisioning route set (status, network, recipes, package
 * registry, profiles) on the shared router.
 * @param {import('express').Router} router - Application router
 */
const registerProvisioningRoutes = router => {
  // Provisioning Routes
  router.get('/provisioning/status', verifyApiKey, getProvisioningStatus);
  router.get('/provisioning/bridged-interfaces', verifyApiKey, getBridgedInterfaces); // All valid VNIC parents (shared wire with the Go agent)
  router.get('/provisioning/network/status', verifyApiKey, getProvisioningNetworkStatus); // Check provisioning network status
  router.post('/provisioning/network/setup', verifyApiKey, setupProvisioningNetwork); // Setup provisioning network
  router.delete('/provisioning/network/teardown', verifyApiKey, teardownProvisioningNetwork); // Teardown provisioning network

  // Provisioning Recipe Routes
  router.get('/provisioning/recipes', verifyApiKey, listRecipes); // List all recipes
  router.post('/provisioning/recipes', verifyApiKey, createRecipe); // Create recipe
  router.get('/provisioning/recipes/:id', verifyApiKey, getRecipe); // Get recipe details
  router.put('/provisioning/recipes/:id', verifyApiKey, updateRecipe); // Update recipe
  router.delete('/provisioning/recipes/:id', verifyApiKey, deleteRecipe); // Delete recipe
  router.post('/provisioning/recipes/:id/test', verifyApiKey, testRecipe); // Test recipe against zone

  // Provisioner Package Registry Routes (D14 provisioner-registry surface —
  // version paths carry the /versions/ segment, the Go agent's exact wire).
  // Literal paths register before the :name wildcards.
  router.get('/provisioning/provisioners', verifyApiKey, listProvisioners);
  router.post('/provisioning/provisioners/import', verifyApiKey, importProvisioner);
  router.post(
    '/provisioning/provisioners/import-upload',
    verifyApiKey,
    provisionerUploadSingle('file'),
    importProvisionerUpload,
    handleProvisionerUploadError
  ); // Multipart package upload → import task (share surface, design §7)
  router.post('/provisioning/provisioners/refresh-specs', verifyApiKey, refreshProvisionerSpecs);
  router.get('/provisioning/catalog', verifyApiKey, getCatalog); // Fetch a catalog (HACS-model feed; ?source= names a configured entry)
  router.get('/provisioning/catalog/sources', verifyApiKey, getCatalogSources); // Configured catalog sources
  router.post('/provisioning/catalog/install', verifyApiKey, installFromCatalog); // Fresh-fetch + download + verify + import a catalog version (async task)
  router.get('/provisioning/provisioners/:name', verifyApiKey, getProvisionerDetails);
  router.delete('/provisioning/provisioners/:name', verifyApiKey, deleteProvisioner);
  router.post(
    '/provisioning/provisioners/:name/refresh-from-source',
    verifyApiKey,
    refreshProvisionerFromSource
  ); // Re-import a git-imported family from its recorded provenance (non-clobber)
  router.get(
    '/provisioning/provisioners/:name/versions/:version',
    verifyApiKey,
    getProvisionerVersion
  );
  router.delete(
    '/provisioning/provisioners/:name/versions/:version',
    verifyApiKey,
    deleteProvisionerVersion
  );
  router.post(
    '/provisioning/provisioners/:name/versions/:version/export',
    verifyApiKey,
    exportProvisioner
  ); // Export a version as registry-shaped tar.gz + sha256 sidecar (async task, shared wire)

  // Provisioning profiles: REMOVED (design §9, ruled 2026-07-16) — a storage
  // feature whose consume side was never built. Nothing replaces them.
};

/**
 * Register the core route set on the shared router.
 * @param {import('express').Router} router - Application router
 */
export const registerCoreRoutes = router => {
  registerProvisioningRoutes(router);

  // Version and Update Routes
  router.get('/version', verifyApiKey, getVersion); // Get application version information
  router.get('/app/updates/check', verifyApiKey, checkForAppUpdates); // Check for application updates

  // Get configuration for conditional routing
  const statsConfig = config.get('stats') || { public_access: false };
  const uiConfig = config.get('ui') || {};
  const docsConfig = config.get('docs') || {};

  // The Hyperweaver UI artifact (baked into the package) also carries the docs site at
  // ui/docs. Resolve it once, whether or not the SPA itself is served.
  const uiDir = path.resolve(uiConfig.path || path.join(process.cwd(), 'ui'));

  // Docs shim: serve the bundled docs site at /docs (matching its /docs baseurl),
  // independent of the SPA — so a docs-only setup (ui.enabled: false) still exposes
  // /docs. The files ride along inside the UI artifact, so this is free. Disable with
  // docs.enabled: false; the fallback fires only when the docs aren't bundled.
  if (docsConfig.enabled !== false) {
    router.use('/docs', express.static(path.join(uiDir, 'docs')));
    router.get('/docs/*splat', (req, res) => {
      void req;
      res.status(503).json({
        error: 'Documentation not bundled in this build',
        details:
          'The docs site ships inside the Hyperweaver UI artifact (ui/docs); install a UI artifact >= 0.10.5.',
      });
    });
  }

  // UI shim (Direct mode): serve the published Hyperweaver UI SPA at /ui when enabled
  if (uiConfig.enabled) {
    router.use('/ui', express.static(uiDir));
    router.get('/ui/*splat', (req, res) => {
      // SPA fallback: client-side routes resolve to index.html
      void req;
      res.sendFile(path.join(uiDir, 'index.html'), err => {
        if (err && !res.headersSent) {
          res.status(503).json({
            error: 'UI artifact not installed',
            details:
              'The Hyperweaver UI is baked in at package build time - reinstall the package or check ui.path',
          });
        }
      });
    });
    router.get('/', (req, res) => {
      void req;
      res.redirect('/ui/');
    });
  } else {
    // Root route to display registered Zoneweaver Agent instances
    router.get('/', getRoot);
  }

  // Public routes (no authentication required)
  router.get('/status', getStatus); // Public slim identity & capabilities (Hyperweaver dual-mode contract)
  router.get('/api/status', getStatus); // Unconditional alias — the single mode-discovery probe URL for the SPA
  router.get('/api/config/ticket', getTicketConfig); // Help & Support link feed (the Server's public URL, Go parity)
  router.post('/api-keys/bootstrap', bootstrapFirstApiKey); // Bootstrap endpoint for initial setup

  // Conditionally public stats endpoint
  if (statsConfig.public_access) {
    router.get('/stats', serverStats); // Public access to server stats
  } else {
    router.get('/stats', verifyApiKey, serverStats); // Protected access to server stats
  }

  // API Key protected routes (require valid API key)
  router.post('/api-keys/generate', verifyApiKey, generateApiKey); // Generate new API key
  router.get('/api-keys', verifyApiKey, listApiKeys); // List all API keys
  router.get('/api-keys/info', verifyApiKey, getApiKeyInfo); // Get current API key info
  router.delete('/api-keys/:id', verifyApiKey, deleteApiKey); // Delete an API key
  router.put('/api-keys/:id/revoke', verifyApiKey, revokeApiKey); // Revoke an API key

  // WebSocket Ticket Route (every WS upgrade requires ?ticket= minted here)
  router.get('/ws-ticket', verifyApiKey, getWsTicket);

  // Global Secrets Routes (architecture D-C — the converged /secrets wire;
  // advertised by the `secrets` feature token)
  router.get('/secrets', verifyApiKey, getSecrets); // The whole secrets document, plain by design
  router.put('/secrets', verifyApiKey, updateSecrets); // Replace submitted categories (settings-style shallow merge)

  // Settings Management Routes
  router.get('/settings', verifyApiKey, getSettings); // Get current application settings
  router.get('/settings/schema', verifyApiKey, getSettingsSchema); // Get settings schema with types/defaults/descriptions
  router.put('/settings', verifyApiKey, updateSettings); // Update application settings
  router.post('/settings/backup', verifyApiKey, createConfigBackup); // Create a configuration backup
  router.get('/settings/backups', verifyApiKey, listBackups); // List configuration backups
  router.delete('/settings/backups/:filename', verifyApiKey, deleteBackup); // Delete a specific backup
  router.post('/settings/restore/:filename', verifyApiKey, restoreBackup); // Restore configuration from backup
  router.post('/server/restart', verifyApiKey, restartServer); // Restart the server (SMF exit-restart)
};
