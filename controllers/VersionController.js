/**
 * @fileoverview Version and Update Controller
 * @description Endpoints for version information and update checking
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import os from 'os';
import axios from 'axios';
import config from '../config/ConfigLoader.js';
import { log } from '../lib/Logger.js';
import {
  directSuccessResponse,
  errorResponse,
} from './SystemHostController/utils/ResponseHelpers.js';

const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

/**
 * Compare two semver version strings
 * @param {string} a - First version
 * @param {string} b - Second version
 * @returns {number} 1 if a > b, -1 if a < b, 0 if equal
 */
const compareVersions = (a, b) => {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) {
      return 1;
    }
    if (na < nb) {
      return -1;
    }
  }
  return 0;
};

/**
 * @swagger
 * /version:
 *   get:
 *     summary: Get application version information
 *     description: Returns the current application version, Node.js version, platform, and architecture.
 *     tags: [System]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Version information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 version:
 *                   type: string
 *                   example: "0.1.14"
 *                 name:
 *                   type: string
 *                   example: "zoneweaver-agent"
 *                 node_version:
 *                   type: string
 *                   example: "v20.10.0"
 *                 platform:
 *                   type: string
 *                   example: "sunos"
 *                 arch:
 *                   type: string
 *                   example: "x64"
 *                 uptime_seconds:
 *                   type: integer
 *                   description: Process uptime in seconds
 */
export const getVersion = (req, res) => {
  void req;
  return directSuccessResponse(res, 'Version information retrieved', {
    version: packageJson.version,
    name: packageJson.name,
    node_version: process.version,
    platform: os.platform(),
    arch: os.arch(),
    uptime_seconds: Math.floor(process.uptime()),
  });
};

/**
 * @swagger
 * /app/updates/check:
 *   get:
 *     summary: Check for application updates
 *     description: |
 *       Fetches the remote versioninfo.json and compares it against the current version.
 *       Requires `updates.versioninfo_url` to be configured in the application settings.
 *     tags: [System]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Update check completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 current_version:
 *                   type: string
 *                 latest_version:
 *                   type: string
 *                 update_available:
 *                   type: boolean
 *                 release_url:
 *                   type: string
 *                   nullable: true
 *                 release_date:
 *                   type: string
 *                   nullable: true
 *                 changelog:
 *                   type: string
 *                   nullable: true
 *       400:
 *         description: Update checking not configured
 *       500:
 *         description: Failed to check for updates
 */
export const checkForAppUpdates = async (req, res) => {
  void req;
  try {
    const updatesConfig = config.get('updates') || {};
    const versionInfoUrl = updatesConfig.versioninfo_url;

    if (!versionInfoUrl) {
      return errorResponse(
        res,
        400,
        'Update checking not configured',
        'Set updates.versioninfo_url in configuration'
      );
    }

    const response = await axios.get(versionInfoUrl, { timeout: 10000 });
    const remoteInfo = response.data;

    const currentVersion = packageJson.version;
    const latestVersion = remoteInfo.version;
    const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;

    return directSuccessResponse(res, 'Update check completed', {
      current_version: currentVersion,
      latest_version: latestVersion,
      update_available: updateAvailable,
      release_url: remoteInfo.releaseUrl || null,
      release_date: remoteInfo.releaseDate || null,
      changelog: remoteInfo.changelog || null,
    });
  } catch (error) {
    log.app.error('Error checking for updates', {
      error: error.message,
    });
    return errorResponse(res, 500, 'Failed to check for updates', error.message);
  }
};
