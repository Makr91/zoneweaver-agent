/**
 * @fileoverview VNC Proxy Controller
 * @description Handles VNC console HTML and asset proxying
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { validateZoneName } from './utils/VncValidation.js';
import { sessionManager } from './utils/VncSessionManager.js';
import { errorResponse } from '../SystemHostController/utils/ResponseHelpers.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /zones/{zoneName}/vnc/console:
 *   get:
 *     summary: Serve VNC console HTML content
 *     description: Proxies the main VNC console HTML page from the VNC server
 *     tags: [VNC Console]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone
 *     responses:
 *       200:
 *         description: VNC console HTML served successfully
 *       404:
 *         description: No active VNC session found
 *       500:
 *         description: Failed to proxy VNC content
 */
export const serveVncConsole = async (req, res) => {
  try {
    const { zoneName } = req.params;

    log.websocket.debug('VNC console request', { zone_name: zoneName });

    if (!validateZoneName(zoneName)) {
      return errorResponse(res, 400, 'Invalid zone name');
    }

    // Get active VNC session info
    const sessionInfo = sessionManager.getSessionInfo(zoneName);
    if (!sessionInfo) {
      log.websocket.warn('No active VNC session found for console request', {
        zone_name: zoneName,
      });
      return errorResponse(res, 404, 'No active VNC session found');
    }

    // Proxy to actual VNC server
    const vncUrl = `http://127.0.0.1:${sessionInfo.port}/`;
    log.websocket.debug('Proxying VNC console', { vnc_url: vncUrl });

    try {
      const response = await fetch(vncUrl);

      if (!response.ok) {
        log.websocket.error('VNC server responded with error', {
          status: response.status,
          vnc_port: sessionInfo.port,
        });
        return res.status(502).json({
          error: 'VNC server not responding',
          vnc_port: sessionInfo.port,
          status: response.status,
        });
      }

      // Add aggressive cache-busting headers
      res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
        'Content-Type': response.headers.get('content-type') || 'text/html',
      });

      // Convert Web ReadableStream to Node.js stream and pipe
      log.websocket.debug('VNC console content streaming', { zone_name: zoneName });

      const { Readable } = await import('stream');
      const nodeStream = Readable.fromWeb(response.body);

      return new Promise(resolve => {
        nodeStream.pipe(res);
        nodeStream.on('end', () => resolve());
        nodeStream.on('error', streamError => {
          log.websocket.error('Stream error', { error: streamError.message });
          resolve();
        });
      });
    } catch (fetchError) {
      log.websocket.error('Failed to fetch VNC content', {
        vnc_url: vncUrl,
        error: fetchError.message,
      });
      return res.status(502).json({
        error: 'Failed to connect to VNC server',
        details: fetchError.message,
        vnc_port: sessionInfo.port,
      });
    }
  } catch (error) {
    log.websocket.error('VNC console error', {
      zone_name: req.params.zoneName,
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to serve VNC console',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /zones/{zoneName}/vnc/*:
 *   get:
 *     summary: Proxy VNC assets
 *     description: Proxies VNC assets (JavaScript, CSS, images, etc.) from the VNC server
 *     tags: [VNC Console]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone
 *     responses:
 *       200:
 *         description: VNC asset served successfully
 *       404:
 *         description: No active VNC session found or asset not found
 *       500:
 *         description: Failed to proxy VNC asset
 */
export const proxyVncContent = async (req, res) => {
  try {
    const { zoneName } = req.params;
    const assetPath = Array.isArray(req.params.splat)
      ? req.params.splat.join('/')
      : req.params.splat || '';

    if (!validateZoneName(zoneName)) {
      return errorResponse(res, 400, 'Invalid zone name');
    }

    log.websocket.debug('VNC asset request', {
      zone_name: zoneName,
      asset_path: assetPath,
    });

    // Get active VNC session info
    const sessionInfo = sessionManager.getSessionInfo(zoneName);
    if (!sessionInfo) {
      log.websocket.warn('No active VNC session found for asset request', {
        zone_name: zoneName,
        asset_path: assetPath,
      });
      return errorResponse(res, 404, 'No active VNC session found');
    }

    // Build VNC server asset URL and proxy directly
    const vncUrl = `http://127.0.0.1:${sessionInfo.port}/${assetPath}`;
    log.websocket.debug('Proxying VNC asset', { vnc_url: vncUrl });

    try {
      const response = await fetch(vncUrl);

      if (!response.ok) {
        log.websocket.warn('VNC asset not found', {
          asset_path: assetPath,
          status: response.status,
          vnc_port: sessionInfo.port,
        });
        return res.status(response.status).json({
          error: 'VNC asset not found',
          asset_path: assetPath,
          vnc_port: sessionInfo.port,
          status: response.status,
        });
      }

      const contentType = response.headers.get('content-type') || 'application/octet-stream';

      // Stream asset directly without caching
      res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
        'Content-Type': contentType,
      });

      // Convert Web ReadableStream to Node.js stream and pipe
      const { Readable } = await import('stream');
      const nodeStream = Readable.fromWeb(response.body);

      return new Promise(resolve => {
        nodeStream.pipe(res);
        nodeStream.on('end', () => resolve());
        nodeStream.on('error', streamError => {
          log.websocket.error('Asset stream error', { error: streamError.message });
          resolve();
        });
      });
    } catch (fetchError) {
      log.websocket.error('Failed to fetch VNC asset', {
        vnc_url: vncUrl,
        error: fetchError.message,
        asset_path: assetPath,
      });
      return res.status(502).json({
        error: 'Failed to connect to VNC server for asset',
        details: fetchError.message,
        asset_path: assetPath,
        vnc_port: sessionInfo.port,
      });
    }
  } catch (error) {
    log.websocket.error('VNC asset error', {
      zone_name: req.params.zoneName,
      error: error.message,
      stack: error.stack,
      asset_path: req.params.splat,
    });
    return res.status(500).json({
      error: 'Failed to proxy VNC asset',
      details: error.message,
    });
  }
};
