/**
 * @fileoverview SSL Certificate Manager for Zoneweaver Agent
 * @description Handles SSL certificate generation and management
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { execSync } from 'child_process';
import { log } from './Logger.js';

/**
 * Generate SSL certificates if they don't exist and generate_ssl is enabled
 * @param {Object} sslConfig - SSL configuration from config.yaml
 * @returns {Promise<boolean>} True if certificates were generated
 */
export const generateSSLCertificatesIfNeeded = sslConfig => {
  if (!sslConfig.generate_ssl) {
    return false; // SSL generation disabled
  }

  const keyPath = sslConfig.key_path;
  const certPath = sslConfig.cert_path;

  // Check if certificates already exist
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    log.app.info('SSL certificates already exist, skipping generation', {
      key_path: keyPath,
      cert_path: certPath,
    });
    return false; // Certificates exist, no need to generate
  }

  try {
    log.app.info('Generating SSL certificates', {
      key_path: keyPath,
      cert_path: certPath,
    });

    // Ensure SSL directory exists
    const sslDir = path.dirname(keyPath);
    if (!fs.existsSync(sslDir)) {
      fs.mkdirSync(sslDir, { recursive: true, mode: 0o700 });
    }

    // Generate SSL certificate using OpenSSL
    const opensslCmd = `openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -subj "/C=US/ST=State/L=City/O=Zoneweaver/CN=localhost"`;

    execSync(opensslCmd, { stdio: 'pipe' });

    // Set proper permissions (readable by current user only)
    fs.chmodSync(keyPath, 0o600);
    fs.chmodSync(certPath, 0o600);

    log.app.info('SSL certificates generated successfully', {
      key_path: keyPath,
      cert_path: certPath,
      validity_days: 365,
    });

    return true; // Certificates generated successfully
  } catch (error) {
    log.app.error('Failed to generate SSL certificates', {
      error: error.message,
      stack: error.stack,
      fallback: 'HTTP only',
    });
    return false; // Generation failed
  }
};

/**
 * Setup HTTPS server with SSL certificate handling
 * @param {Object} app - Express application instance
 * @param {Object} sslConfig - SSL configuration
 * @param {number} httpsPort - HTTPS port
 * @param {Object} serverConfig - Server configuration
 * @param {Function} handleWebSocketUpgrade - WebSocket upgrade handler
 * @param {Object} wss - WebSocket server instance
 * @returns {Promise<void>}
 */
export const setupHTTPSServer = (
  app,
  sslConfig,
  httpsPort,
  serverConfig,
  handleWebSocketUpgrade,
  wss
) => {
  if (!sslConfig.enabled) {
    log.app.info('SSL disabled in configuration', {
      https_enabled: false,
      server_mode: 'HTTP only',
    });
    return;
  }

  // Try to generate SSL certificates if needed
  generateSSLCertificatesIfNeeded(sslConfig);

  try {
    const privateKey = fs.readFileSync(sslConfig.key_path, 'utf8');
    const certificate = fs.readFileSync(sslConfig.cert_path, 'utf8');

    const credentials = { key: privateKey, cert: certificate };

    const httpsServer = https.createServer(credentials, app);

    // Add WebSocket upgrade handler for HTTPS server
    httpsServer.on('upgrade', (request, socket, head) => {
      handleWebSocketUpgrade(request, socket, head, wss);
    });

    httpsServer.listen(httpsPort, () => {
      const host = serverConfig.hostname || 'localhost';
      log.app.info('HTTPS server started', {
        port: httpsPort,
        host,
        api_docs_url: `https://${host}:${httpsPort}/api-docs`,
      });
    });
  } catch (error) {
    log.app.error('SSL Certificate Error', {
      error: error.message,
      key_path: sslConfig.key_path,
      cert_path: sslConfig.cert_path,
    });
    log.app.warn('HTTPS server not started due to SSL certificate issues', {
      required_key_path: sslConfig.key_path,
      required_cert_path: sslConfig.cert_path,
      suggestion: 'Ensure SSL certificates are available or enable generate_ssl',
    });
  }
};
