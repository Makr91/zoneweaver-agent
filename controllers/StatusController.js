/**
 * @fileoverview Status Controller
 * @description Public slim identity & capabilities endpoint for the Hyperweaver dual-mode contract.
 *              This is NOT /stats — no interface/IP/homedir/CPU dumps, identity + capability tokens only.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import os from 'os';
import Entities from '../models/EntityModel.js';
import config from '../config/ConfigLoader.js';
import { log } from '../lib/Logger.js';

const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));

/**
 * Node arch values normalized to the Agent API contract (x86_64 | aarch64)
 */
const ARCH_MAP = {
  x64: 'x86_64',
  arm64: 'aarch64',
};

/**
 * Feature tokens advertised by this agent (kebab-case, presence = supported).
 * Provisional D1 capability mechanism — formalized into Agent API v1 later.
 */
const FEATURES = [
  'zfs',
  'vnics',
  'fault-management',
  'provisioning',
  'packages',
  'boot-environments',
];

/**
 * @swagger
 * /status:
 *   get:
 *     summary: Get agent identity and capabilities
 *     description: |
 *       Public slim status payload for the Hyperweaver dual-mode contract.
 *       Identifies this backend as an agent, advertises its capability tokens
 *       (auth, console, hypervisors, features) and whether API-key bootstrap
 *       is still available. Contains no system internals — see /stats for those.
 *     tags: [System]
 *     security: []
 *     responses:
 *       200:
 *         description: Agent status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 role:
 *                   type: string
 *                   example: "agent"
 *                 agent:
 *                   type: string
 *                   example: "zoneweaver-agent"
 *                 hypervisors:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["bhyve"]
 *                 platform:
 *                   type: string
 *                   example: "omnios"
 *                 arch:
 *                   type: string
 *                   example: "x86_64"
 *                 version:
 *                   type: string
 *                   example: "0.2.3"
 *                 hostname:
 *                   type: string
 *                   example: "host1.example.com"
 *                 auth:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["apikey"]
 *                 bootstrapAvailable:
 *                   type: boolean
 *                   description: True until the first API key exists (drives first-boot UX)
 *                   example: true
 *                 console:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["vnc"]
 *                 features:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["zfs", "vnics", "fault-management", "provisioning", "packages", "boot-environments"]
 *                 uptime:
 *                   type: integer
 *                   description: Process uptime in seconds
 *                   example: 12345
 *       500:
 *         description: Failed to retrieve status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export const getStatus = async (req, res) => {
  void req;
  try {
    const apiKeyConfig = config.get('api_keys') || {};

    // Mirror the exact availability check bootstrapFirstApiKey enforces
    const entityCount = await Entities.count();
    const bootstrapAvailable =
      Boolean(apiKeyConfig.bootstrap_enabled) &&
      (entityCount === 0 || apiKeyConfig.bootstrap_auto_disable === false);

    return res.json({
      role: 'agent',
      agent: 'zoneweaver-agent',
      hypervisors: ['bhyve'],
      platform: os.platform() === 'sunos' ? 'omnios' : os.platform(),
      arch: ARCH_MAP[os.arch()] || os.arch(),
      version: packageJson.version,
      hostname: os.hostname(),
      auth: ['apikey'],
      bootstrapAvailable,
      console: ['vnc'],
      features: FEATURES,
      uptime: Math.floor(process.uptime()),
    });
  } catch (error) {
    log.api.error('Error retrieving agent status', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to retrieve status',
      details: error.message,
    });
  }
};
