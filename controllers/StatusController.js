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
 * Feature tokens advertised by this agent (kebab-case, presence = supported) —
 * Agent API v1 capability model (D1 / contract C7). A token is advertised iff
 * the platform supports the surface AND, where a config kill-switch exists,
 * that block is enabled. Full token↔panel↔endpoint mapping lives in
 * hyperweaver-docs: docs/zoneweaver-agent/capability-model.md.
 */

/**
 * Platform tokens — core OmniOS/bhyve surfaces with no config kill-switch;
 * always advertised by this agent.
 */
const PLATFORM_FEATURES = [
  'machines',
  'machine-create',
  // machine-modify: PUT /machines/{name} (zonecfg modify pipeline) — the UI's
  // Edit modal gates on it. machine-screenshot: GET
  // /machines/{name}/vnc/screenshot (bhyve framebuffer PNG). Token names
  // shared with the Go agent's platformFeatures.
  'machine-modify',
  'machine-screenshot',
  // machine-snapshots: the ZFS-native snapshot family
  // (/machines/{name}/snapshots — list/take/restore/delete + rotation).
  'machine-snapshots',
  'services',
  'zfs',
  'vnics',
  'boot-environments',
  'packages',
  'repositories',
  'swap',
  'time-sync',
  'system-users',
  'processes',
  // ssh (the machine SSH terminal) is a FEATURE — it rides the guest's own
  // network/credentials. Emergency consoles (vnc, zlogin) live in console[]
  // (Mark's taxonomy ruling 2026-07-12).
  'ssh',
  'host-terminal',
  // host-power gates the /system/host/* power surface (status/uptime +
  // shutdown/restart/poweroff/halt/runlevel). Always served here (no config
  // kill switch) → platform token; the Go agent config-gates its equivalent.
  'host-power',
  'tasks',
  'provisioning',
  // provisioner-registry: the SHI-format package-registry surface
  // (/provisioning/provisioners*) — D14 token, shipped with the registry
  // parity phase.
  'provisioner-registry',
  // secrets: the global secrets store (GET/PUT /secrets, architecture D-C) —
  // always available, no config kill-switch; the UI's Secrets tab gates on it.
  'secrets',
  // hosts-file: the /system/hosts editor (Mark's token-gating pick,
  // 2026-07-17) — twin of the Go agent's mint; the UI's Hosts File tab
  // gates on it.
  'hosts-file',
];

/**
 * Config-gated tokens: [token, config key]. Advertised only when the config
 * block is enabled, mirroring the controllers' own kill-switches (e.g. the
 * fault-management endpoints return 503 when fault_management.enabled is
 * false — the token must not be advertised in that state).
 */
const CONFIG_GATED_FEATURES = [
  ['fault-management', 'fault_management.enabled'],
  ['devices', 'host_monitoring.enabled'],
  ['monitoring', 'host_monitoring.enabled'],
  // syslog + log-streaming share the system_logs kill switch: syslog = the
  // /system/syslog/* config family, log-streaming = the /system/logs/* viewer
  // and streaming family. Both 503 when system_logs is disabled, so neither
  // token may be advertised in that state (D14: advertise only shipped surfaces).
  ['syslog', 'system_logs.enabled'],
  ['log-streaming', 'system_logs.enabled'],
  ['file-browser', 'file_browser.enabled'],
  ['artifacts', 'artifact_storage.enabled'],
  ['templates', 'template_sources.enabled'],
  // guest-agent: the QEMU guest-agent channel (/machines/{name}/guest/*) —
  // credential-less guest control over the zone's virtio-console qga socket.
  ['guest-agent', 'guest_agent.enabled'],
  // machine-suspend: POST /machines/{name}/suspend + /resume (bhyvectl
  // checkpoint; start also restores). Shared token with the Go agent —
  // experimental here: the bhyvectl flag is dev-marked.
  ['machine-suspend', 'experimental.enabled'],
];

/**
 * Build the feature-token list from platform support + live config state.
 * @returns {string[]} Advertised feature tokens
 */
const buildFeatures = () => [
  ...PLATFORM_FEATURES,
  ...CONFIG_GATED_FEATURES.filter(([, key]) => Boolean(config.get(key))).map(([token]) => token),
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
 *                   description: Hypervisor-level EMERGENCY consoles (zero guest cooperation needed)
 *                   items:
 *                     type: string
 *                   example: ["vnc", "zlogin"]
 *                 features:
 *                   type: array
 *                   description: |
 *                     Capability feature tokens (Agent API v1, contract C7). Derived from
 *                     platform support AND config state — a config-disabled surface is not
 *                     advertised. UIs must gate panels with features.includes(token).
 *                   items:
 *                     type: string
 *                   example: ["machines", "machine-create", "machine-modify", "machine-screenshot", "machine-snapshots", "services", "zfs", "vnics", "boot-environments", "packages", "repositories", "swap", "time-sync", "system-users", "processes", "ssh", "host-terminal", "host-power", "tasks", "provisioning", "provisioner-registry", "secrets", "hosts-file", "fault-management", "devices", "monitoring", "syslog", "log-streaming", "file-browser", "artifacts", "templates", "guest-agent", "machine-suspend"]
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
      // Emergency consoles only (work with zero guest cooperation): the bhyve
      // framebuffer over VNC and zlogin. The machine SSH terminal is the ssh
      // FEATURE token.
      console: ['vnc', 'zlogin'],
      features: buildFeatures(),
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
