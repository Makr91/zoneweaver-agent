import axios from 'axios';
import fs from 'fs';
import https from 'https';
import tls from 'tls';
import config from '../config/ConfigLoader.js';
import { log } from './Logger.js';

/**
 * @fileoverview Template Registry Utilities
 * @description Registry auth + transport, shared with the Go agent (Mark's ruling:
 * "API keys, PERIOD"): ONE raw service-account token per source, sent as Bearer on
 * every call — BoxVault accepts it everywhere. Self-signed registries are handled
 * properly: the source's ca_file JOINS the trust store; verification always stays ON.
 * The Vagrant user agent rides every /api call; the catalog discover call uses the
 * plain agent (BoxVault's vagrantHandler middleware parses any two-segment
 * Vagrant-UA path as {org}/{box} — /api/discover would become box "discover").
 */

const VAGRANT_USER_AGENT = 'Vagrant/2.2.19 Zoneweaver/1.0.0';
const PLAIN_USER_AGENT = 'Zoneweaver/1.0.0';

/**
 * Resolve the source's credential: the configured service-account token
 * (BoxVault), used raw. The source credential is the ONLY registry auth —
 * per-request overrides deliberately have no analog (tokens never ride task
 * metadata; the Go agent's exact rule).
 * @param {Object} sourceConfig - Source configuration from config.yaml
 * @returns {string} Bearer token
 */
export const getRegistryToken = sourceConfig => sourceConfig.auth_token || '';

/**
 * Build the trust bundle for a source: the system roots plus the source's
 * ca_file PEM. Unreadable files log loudly and fall back to the system store —
 * verification is never disabled.
 * @param {Object} sourceConfig - Source configuration
 * @returns {string[]|null} CA bundle, or null for the default store
 */
export const buildRegistryCA = sourceConfig => {
  if (!sourceConfig.ca_file) {
    return null;
  }
  try {
    const pem = fs.readFileSync(sourceConfig.ca_file, 'utf8');
    return [...tls.rootCertificates, pem];
  } catch (error) {
    log.task.error('registry ca_file unreadable — system trust store only', {
      source: sourceConfig.name,
      ca_file: sourceConfig.ca_file,
      error: error.message,
    });
    return null;
  }
};

/**
 * Create an authenticated axios client for a registry source.
 * @param {Object} sourceConfig - Source configuration from config.yaml
 * @param {string} token - Registry API key (raw Bearer)
 * @param {Object} [options] - { plainUA: true } for the discover catalog call
 * @returns {import('axios').AxiosInstance} Configured axios instance
 */
export const createRegistryClient = (sourceConfig, token, options = {}) => {
  const headers = {
    'User-Agent': options.plainUA ? PLAIN_USER_AGENT : VAGRANT_USER_AGENT,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const ca = buildRegistryCA(sourceConfig);
  return axios.create({
    baseURL: sourceConfig.url,
    headers,
    httpsAgent: ca ? new https.Agent({ ca }) : undefined,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
};

/**
 * Find a template source configuration by name
 * @param {string} sourceName - Name of the source to find
 * @returns {Object|null} Source configuration or null
 */
export const findSourceConfig = sourceName => {
  const templateConfig = config.getTemplateSources();
  if (!templateConfig?.sources) {
    return null;
  }
  return templateConfig.sources.find(s => s.name === sourceName && s.enabled) || null;
};

/**
 * Find the default-flagged template source (the Go agent's resolution when a
 * request names no source).
 * @returns {Object|null} Source configuration or null when none is flagged
 */
export const findDefaultSourceConfig = () => {
  const templateConfig = config.getTemplateSources();
  if (!templateConfig?.sources) {
    return null;
  }
  return templateConfig.sources.find(s => s.enabled && s.default) || null;
};

/**
 * Query registry to get latest version of a box
 * @param {string} org - Organization name
 * @param {string} boxName - Box name
 * @param {Object} sourceConfig - Source configuration
 * @returns {Promise<string>} Latest version number
 */
export const queryLatestBoxVersion = async (org, boxName, sourceConfig) => {
  const token = getRegistryToken(sourceConfig);
  const client = createRegistryClient(sourceConfig, token);

  // Vagrant-compatible metadata endpoint
  const response = await client.get(`/${org}/${boxName}`);
  const versions = response.data.versions || [];

  if (versions.length === 0) {
    throw new Error(`No versions available for ${org}/${boxName}`);
  }

  // Sort versions numerically (semver-aware)
  const [latestVersion] = versions
    .map(v => v.version)
    .sort((a, b) => {
      const aParts = a.split('.').map(Number);
      const bParts = b.split('.').map(Number);
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const diff = (bParts[i] || 0) - (aParts[i] || 0);
        if (diff !== 0) {
          return diff;
        }
      }
      return 0;
    });

  return latestVersion;
};
