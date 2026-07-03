/**
 * @fileoverview Host Configuration Controller
 * @description Endpoints for managing host-level configuration files (/etc/hosts, /etc/resolv.conf)
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { readFile, writeFile, copyFile } from 'fs/promises';
import { log } from '../lib/Logger.js';
import {
  directSuccessResponse,
  errorResponse,
} from './SystemHostController/utils/ResponseHelpers.js';

const HOSTS_FILE = '/etc/hosts';
const RESOLV_FILE = '/etc/resolv.conf';

/**
 * Parse /etc/hosts into structured entries
 * @param {string} content - Raw file content
 * @returns {Array<Object>} Parsed host entries
 */
const parseHostsFile = content => {
  const entries = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const [ip, ...hostnames] = parts;
      entries.push({ ip, hostnames });
    }
  }

  return entries;
};

/**
 * Serialize host entries back to /etc/hosts format
 * Preserves a standard header comment
 * @param {Array<Object>} entries - Host entries
 * @returns {string} File content
 */
const serializeHostsFile = entries => {
  const lines = [
    '# /etc/hosts - managed by zoneweaver-agent',
    '#',
    '# IP Address    Hostnames',
    '',
  ];

  for (const entry of entries) {
    const hostnames = Array.isArray(entry.hostnames) ? entry.hostnames.join('\t') : entry.hostnames;
    lines.push(`${entry.ip}\t${hostnames}`);
  }

  lines.push('');
  return lines.join('\n');
};

/**
 * Parse /etc/resolv.conf into structured config
 * @param {string} content - Raw file content
 * @returns {Object} Parsed DNS configuration
 */
const parseResolvConf = content => {
  const nameservers = [];
  const searchDomains = [];
  let domain = null;
  const options = [];

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
      continue;
    }

    const [directive, ...rest] = trimmed.split(/\s+/);

    if (directive === 'nameserver' && rest[0]) {
      nameservers.push(rest[0]);
    } else if (directive === 'search') {
      searchDomains.push(...rest);
    } else if (directive === 'domain' && rest[0]) {
      [domain] = rest;
    } else if (directive === 'options') {
      options.push(...rest);
    }
  }

  return { nameservers, search_domains: searchDomains, domain, options };
};

/**
 * Serialize DNS config back to /etc/resolv.conf format
 * @param {Object} dnsConfig - DNS configuration
 * @returns {string} File content
 */
const serializeResolvConf = dnsConfig => {
  const lines = ['# /etc/resolv.conf - managed by zoneweaver-agent', ''];

  if (dnsConfig.domain) {
    lines.push(`domain ${dnsConfig.domain}`);
  }

  if (dnsConfig.search_domains?.length > 0) {
    lines.push(`search ${dnsConfig.search_domains.join(' ')}`);
  }

  for (const ns of dnsConfig.nameservers || []) {
    lines.push(`nameserver ${ns}`);
  }

  if (dnsConfig.options?.length > 0) {
    lines.push(`options ${dnsConfig.options.join(' ')}`);
  }

  lines.push('');
  return lines.join('\n');
};

/**
 * Create a timestamped backup of a file
 * @param {string} filePath - Path to file
 */
const backupFile = async filePath => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.bak.${timestamp}`;
  await copyFile(filePath, backupPath);
  return backupPath;
};

/**
 * @swagger
 * /system/hosts:
 *   get:
 *     summary: Get /etc/hosts entries
 *     description: Reads and parses /etc/hosts into structured JSON
 *     tags: [Host Configuration]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Hosts file retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 entries:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       ip:
 *                         type: string
 *                         example: "127.0.0.1"
 *                       hostnames:
 *                         type: array
 *                         items:
 *                           type: string
 *                         example: ["localhost", "localhost.localdomain"]
 *                 raw:
 *                   type: string
 *                   description: Raw file contents
 *       500:
 *         description: Failed to read hosts file
 */
export const getHosts = async (req, res) => {
  void req;
  try {
    const content = await readFile(HOSTS_FILE, 'utf-8');
    const entries = parseHostsFile(content);

    return directSuccessResponse(res, 'Hosts file retrieved successfully', {
      entries,
      raw: content,
    });
  } catch (error) {
    log.api.error('Error reading hosts file', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to read hosts file', error.message);
  }
};

/**
 * @swagger
 * /system/hosts:
 *   put:
 *     summary: Update /etc/hosts entries
 *     description: |
 *       Replaces /etc/hosts with provided entries. Creates a timestamped backup before writing.
 *       Provide either structured `entries` array or `raw` string content.
 *     tags: [Host Configuration]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               entries:
 *                 type: array
 *                 description: Structured host entries (used if `raw` is not provided)
 *                 items:
 *                   type: object
 *                   required: [ip, hostnames]
 *                   properties:
 *                     ip:
 *                       type: string
 *                       example: "127.0.0.1"
 *                     hostnames:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["localhost"]
 *               raw:
 *                 type: string
 *                 description: Raw file content (takes precedence over entries)
 *     responses:
 *       200:
 *         description: Hosts file updated successfully
 *       400:
 *         description: Invalid request body
 *       500:
 *         description: Failed to write hosts file
 */
export const updateHosts = async (req, res) => {
  try {
    const { entries, raw } = req.body;

    if (!entries && !raw) {
      return errorResponse(res, 400, 'Either entries array or raw string is required');
    }

    const backupPath = await backupFile(HOSTS_FILE);

    let content;
    if (raw) {
      content = raw;
    } else {
      content = serializeHostsFile(entries);
    }

    await writeFile(HOSTS_FILE, content, 'utf-8');

    log.api.info('Hosts file updated', {
      updated_by: req.entity.name,
      backup: backupPath,
      entry_count: entries?.length,
    });

    return directSuccessResponse(res, 'Hosts file updated successfully', {
      backup: backupPath,
      entries: parseHostsFile(content),
    });
  } catch (error) {
    log.api.error('Error writing hosts file', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to write hosts file', error.message);
  }
};

/**
 * @swagger
 * /system/dns:
 *   get:
 *     summary: Get DNS configuration
 *     description: Reads and parses /etc/resolv.conf into structured JSON
 *     tags: [Host Configuration]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: DNS configuration retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 nameservers:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["8.8.8.8", "8.8.4.4"]
 *                 search_domains:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["example.com"]
 *                 domain:
 *                   type: string
 *                   nullable: true
 *                   example: "example.com"
 *                 options:
 *                   type: array
 *                   items:
 *                     type: string
 *                 raw:
 *                   type: string
 *                   description: Raw file contents
 *       500:
 *         description: Failed to read DNS configuration
 */
export const getDns = async (req, res) => {
  void req;
  try {
    const content = await readFile(RESOLV_FILE, 'utf-8');
    const dnsConfig = parseResolvConf(content);

    return directSuccessResponse(res, 'DNS configuration retrieved successfully', {
      ...dnsConfig,
      raw: content,
    });
  } catch (error) {
    log.api.error('Error reading resolv.conf', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to read DNS configuration', error.message);
  }
};

/**
 * @swagger
 * /system/dns:
 *   put:
 *     summary: Update DNS configuration
 *     description: |
 *       Updates /etc/resolv.conf with provided configuration.
 *       Creates a timestamped backup before writing.
 *       Provide either structured fields or `raw` string content.
 *     tags: [Host Configuration]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nameservers:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["8.8.8.8", "8.8.4.4"]
 *               search_domains:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["example.com"]
 *               domain:
 *                 type: string
 *                 example: "example.com"
 *               options:
 *                 type: array
 *                 items:
 *                   type: string
 *               raw:
 *                 type: string
 *                 description: Raw file content (takes precedence over structured fields)
 *     responses:
 *       200:
 *         description: DNS configuration updated successfully
 *       400:
 *         description: Invalid request body
 *       500:
 *         description: Failed to write DNS configuration
 */
export const updateDns = async (req, res) => {
  try {
    const { nameservers, search_domains, domain, options, raw } = req.body;

    if (!raw && !nameservers) {
      return errorResponse(res, 400, 'Either nameservers array or raw string is required');
    }

    const backupPath = await backupFile(RESOLV_FILE);

    let content;
    if (raw) {
      content = raw;
    } else {
      content = serializeResolvConf({ nameservers, search_domains, domain, options });
    }

    await writeFile(RESOLV_FILE, content, 'utf-8');

    log.api.info('DNS configuration updated', {
      updated_by: req.entity.name,
      backup: backupPath,
      nameserver_count: nameservers?.length,
    });

    return directSuccessResponse(res, 'DNS configuration updated successfully', {
      backup: backupPath,
      ...parseResolvConf(content),
    });
  } catch (error) {
    log.api.error('Error writing resolv.conf', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to write DNS configuration', error.message);
  }
};
