/**
 * @fileoverview Global secrets store (architecture D-C, SHI's SuperHumanSecrets model)
 * @description The agent's global secrets document — SHI's six repeatable
 * categories persisted to secrets.yaml BESIDE the config file, 0600, served
 * by GET/PUT /secrets. A store of its own purely so GET /settings keeps
 * serving just the configuration document. Values are plain text BY DESIGN
 * (Mark's ruling): it is the user's local machine, and the generated
 * Hosts.yml carries them as SECRETS_* template vars anyway. Independently of
 * those vars, the provisioning runtime merges the working copy's
 * secrets.yml/.secrets.yml — that mechanism coexists and is never touched by
 * this store. Wire and semantics copied from the Go agent's shipped
 * internal/secrets (the converged /secrets contract).
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import config from '../config/ConfigLoader.js';

/** SHI's SecretsPage name rule, minus its empty-string allowance. */
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/u;

/** The three plain name→key categories (one loop serves them all). */
const NAMED_KEY_CATEGORIES = [
  'hcl_download_portal_api_keys',
  'git_api_keys',
  'vagrant_atlas_token',
];

/** SHI's six category names, verbatim — the closed set. */
const CATEGORIES = [...NAMED_KEY_CATEGORIES, 'custom_resource_url', 'docker_hub', 'ssh_keys'];

/**
 * The secrets file lives beside the config file (the setup.token pattern).
 * @returns {string} Absolute path to secrets.yaml
 */
export const getSecretsPath = () => path.join(path.dirname(config.getConfigPath()), 'secrets.yaml');

/** Every category present and non-null — the API serves [] never null. */
const emptyDocument = () => Object.fromEntries(CATEGORIES.map(category => [category, []]));

/**
 * Load the document fresh from disk — a missing file is an empty store;
 * every category normalizes to an array.
 * @returns {Object} The secrets document
 */
export const getSecrets = () => {
  const doc = emptyDocument();
  let raw;
  try {
    raw = fs.readFileSync(getSecretsPath(), 'utf8');
  } catch {
    return doc;
  }
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== 'object') {
    return doc;
  }
  for (const category of CATEGORIES) {
    if (Array.isArray(parsed[category])) {
      doc[category] = parsed[category].filter(entry => entry && typeof entry === 'object');
    }
  }
  return doc;
};

/**
 * Validate every entry name against SHI's rule — the store never
 * half-applies.
 * @param {Object} doc - Candidate document
 * @throws {Error} On the first invalid name
 */
const validateNames = doc => {
  for (const category of CATEGORIES) {
    for (const entry of doc[category]) {
      if (typeof entry.name !== 'string' || !NAME_PATTERN.test(entry.name)) {
        throw new Error(
          `category ${category}: name ${JSON.stringify(entry.name ?? '')} must match [a-zA-Z0-9_-]+`
        );
      }
    }
  }
};

/**
 * PUT /secrets semantics (the Go agent's Replace, the settings surface's
 * top-level shallow merge): the submitted categories overwrite whole,
 * untouched categories survive. Unknown categories and invalid entry names
 * reject the WHOLE update.
 * @param {Object} categories - Map of category → entries array
 * @returns {Object} The persisted document
 * @throws {Error} On unknown category, non-array value, or invalid name
 */
export const replaceSecrets = categories => {
  const updated = getSecrets();
  for (const [category, value] of Object.entries(categories)) {
    if (!CATEGORIES.includes(category)) {
      throw new Error(`unknown secrets category: ${category}`);
    }
    if (!Array.isArray(value)) {
      throw new Error(`category ${category}: must be an array of entries`);
    }
    updated[category] = value.filter(entry => entry && typeof entry === 'object');
  }
  validateNames(updated);

  const file = getSecretsPath();
  fs.writeFileSync(file, yaml.dump(updated), { mode: 0o600 });
  // mode applies only on create — an existing file keeps its bits without this.
  fs.chmodSync(file, 0o600);
  return updated;
};

/**
 * The named git API key ("" when absent) — the private-repo credential for
 * provisioner git imports (the Go agent's GitToken).
 * @param {string} name - git_api_keys entry name
 * @returns {string} The token, or ''
 */
export const getGitToken = name => {
  for (const entry of getSecrets().git_api_keys) {
    if (entry.name === name) {
      return typeof entry.key === 'string' ? entry.key : '';
    }
  }
  return '';
};

/** Uppercase a secret name into template-variable form (hyphens → underscores). */
const sanitizeVarName = name => String(name).toUpperCase().replaceAll('-', '_');

/**
 * The SECRETS_* template variables injected into the generated Hosts.yml
 * (SHI §2.2 semantics, the Go agent's TemplateVars exactly): every
 * category's entries become per-name vars; plain text by design.
 * @returns {Object} Variable map
 */
export const buildSecretsTemplateVars = () => {
  const doc = getSecrets();
  const vars = {};
  for (const category of NAMED_KEY_CATEGORIES) {
    for (const entry of doc[category]) {
      vars[`SECRETS_${sanitizeVarName(entry.name)}`] = entry.key;
    }
  }
  for (const entry of doc.custom_resource_url) {
    const prefix = `SECRETS_${sanitizeVarName(entry.name)}`;
    vars[`${prefix}_URL`] = entry.url;
    if (entry.useAuth) {
      vars[`${prefix}_USER`] = entry.user;
      vars[`${prefix}_PASS`] = entry.pass;
    }
  }
  for (const entry of doc.docker_hub) {
    const prefix = `SECRETS_${sanitizeVarName(entry.name)}`;
    vars[`${prefix}_USER`] = entry.docker_hub_user;
    vars[`${prefix}_TOKEN`] = entry.docker_hub_token;
  }
  for (const entry of doc.ssh_keys) {
    vars[`SECRETS_${sanitizeVarName(entry.name)}_SSH`] = entry.key;
  }
  return vars;
};
