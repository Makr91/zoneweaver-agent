/**
 * @fileoverview Provisioner catalog client (design §7 — the HACS model)
 * @description Fetches catalog.json feeds (format_version 1), resolves a
 * family/version to its VERSIONED artifact (URLs are opaque — release tags
 * carry slashes, never parse or construct them), for download+sha256-verify+
 * import by the provisioner_import task. Sources config mirrors the
 * template-sources pattern; the STARTcloud catalog is the built-in default
 * when none are configured.
 */

import axios from 'axios';
import fs from 'fs';
import https from 'https';
import tls from 'tls';
import config from '../config/ConfigLoader.js';
import { log } from './Logger.js';

const DEFAULT_CATALOG_SOURCE = {
  name: 'startcloud',
  url: 'https://provisioner-catalog.startcloud.com/catalog.json',
  enabled: true,
  default: true,
};

/**
 * The configured catalog sources (provisioning.catalog_sources — mirrors
 * template_sources). An empty/absent list serves the built-in STARTcloud
 * default so item-6 works out of the box.
 * @returns {{enabled: boolean, sources: Array<Object>}}
 */
export const getCatalogSources = () => {
  const catalogConfig = config.get('provisioning.catalog_sources') || {};
  const configured = Array.isArray(catalogConfig.sources) ? catalogConfig.sources : [];
  const sources = (configured.length > 0 ? configured : [DEFAULT_CATALOG_SOURCE]).filter(
    source => source && source.enabled !== false && typeof source.url === 'string'
  );
  return { enabled: catalogConfig.enabled !== false, sources };
};

/**
 * Resolve one catalog source: explicit name wins, else the default-flagged
 * source, else the first.
 * @param {string} [name] - Source name
 * @returns {Object|null} Source entry
 */
export const findCatalogSource = name => {
  const { enabled, sources } = getCatalogSources();
  if (!enabled) {
    return null;
  }
  if (name) {
    return sources.find(source => source.name === name) || null;
  }
  return sources.find(source => source.default) || sources[0] || null;
};

/**
 * A source's trust bundle: the system roots PLUS its ca_file PEM (forked
 * self-hosted catalogs) — verification is never disabled, matching the
 * template-registry rule.
 * @param {Object} source - Catalog source entry
 * @returns {import('https').Agent|undefined} https agent (default store when no ca_file)
 */
export const catalogHttpsAgent = source => {
  if (!source?.ca_file) {
    return undefined;
  }
  try {
    const pem = fs.readFileSync(source.ca_file, 'utf8');
    return new https.Agent({ ca: [...tls.rootCertificates, pem] });
  } catch (error) {
    log.task.error('catalog ca_file unreadable — system trust store only', {
      source: source.name,
      ca_file: source.ca_file,
      error: error.message,
    });
    return undefined;
  }
};

/**
 * Fetch a catalog document and gate on format_version 1 (the consumption
 * contract — anything else is refused, never guessed at).
 * @param {Object} source - Catalog source entry
 * @returns {Promise<Object>} The catalog document
 */
export const fetchCatalog = async source => {
  const response = await axios.get(source.url, {
    timeout: 30000,
    headers: { 'User-Agent': 'Zoneweaver/1.0.0' },
    httpsAgent: catalogHttpsAgent(source),
  });
  const catalog = response.data;
  if (!catalog || typeof catalog !== 'object' || catalog.format_version !== 1) {
    throw new Error(`catalog at ${source.url} is not format_version 1`);
  }
  return catalog;
};

/**
 * Resolve a family/version to its artifact {url, checksum, checksum_type}.
 * Only VERSIONED assets ride the catalog; URLs stay opaque.
 * @param {Object} catalog - Fetched catalog document
 * @param {string} name - Provisioner family name
 * @param {string} version - Exact version
 * @returns {Object|null} Artifact descriptor
 */
export const findCatalogArtifact = (catalog, name, version) => {
  const family = (catalog.provisioners || []).find(entry => entry.name === name);
  if (!family) {
    return null;
  }
  const entry = (family.versions || []).find(v => v.version === version);
  const artifact = entry?.artifacts?.[0];
  if (!artifact || typeof artifact.url !== 'string') {
    return null;
  }
  return {
    url: artifact.url,
    checksum: artifact.checksum,
    checksum_type: artifact.checksum_type || 'sha256',
  };
};
