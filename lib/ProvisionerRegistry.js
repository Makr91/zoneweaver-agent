/**
 * @fileoverview Provisioner package registry (SHI on-disk format, D14 provisioner-registry surface)
 * @description <provisioners dir>/<name>/provisioner-collection.yml with <version>/provisioner.yml
 * trees beneath. The filesystem is the source of truth — packages dropped in by hand appear
 * without registration. Mirrors the Go agent's internal/provisioner registry exactly.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import config from '../config/ConfigLoader.js';
import { deriveJsonSchema } from './FieldDslLint.js';
import { log } from './Logger.js';

export const COLLECTION_MANIFEST = 'provisioner-collection.yml';
export const VERSION_MANIFEST = 'provisioner.yml';

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export const isValidPackageName = name => typeof name === 'string' && NAME_PATTERN.test(name);

export const getRegistryDir = () =>
  config.get('provisioning.provisioners_path') || '/var/lib/zoneweaver-agent/provisioners';

const readManifest = file => yaml.load(fs.readFileSync(file, 'utf8'));

const metaString = (doc, key) => (doc && typeof doc[key] === 'string' ? doc[key] : '');

export const compareVersions = (a, b) => {
  const split = s => String(s).split(/[.-]/u);
  const as = split(a);
  const bs = split(b);
  for (let i = 0; i < as.length && i < bs.length; i++) {
    const an = Number(as[i]);
    const bn = Number(bs[i]);
    if (Number.isInteger(an) && Number.isInteger(bn) && `${an}` === as[i] && `${bn}` === bs[i]) {
      if (an !== bn) {
        return an < bn ? -1 : 1;
      }
      continue;
    }
    const c = as[i].localeCompare(bs[i]);
    if (c !== 0) {
      return c;
    }
  }
  return as.length - bs.length;
};

/**
 * Import provenance — REGISTRY-side, per family (never inside the package
 * files): {source_type: 'git', url, branch?, token_name?} recorded by git
 * imports so refresh-from-source can re-run the ordinary import later
 * (token_name NAMES a git_api_keys secrets entry — the token itself never
 * lands here). Families from folder/archive/catalog imports carry none.
 * Dot-prefixed on purpose (the Go agent's converged sidecar name): dot-led
 * entries never read as version directories and share archives never carry
 * it.
 */
export const SOURCE_FILE = '.source.json';

export const readFamilySource = name => {
  if (!isValidPackageName(name)) {
    return null;
  }
  const file = path.join(getRegistryDir(), name, SOURCE_FILE);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    log.api.warn('Unreadable family source provenance', { file, error: error.message });
    return null;
  }
};

export const recordFamilySource = (name, source) => {
  const familyDir = path.join(getRegistryDir(), name);
  if (!fs.existsSync(familyDir)) {
    return;
  }
  fs.writeFileSync(path.join(familyDir, SOURCE_FILE), `${JSON.stringify(source, null, 2)}\n`, {
    mode: 0o644,
  });
};

export const synthesizeCollectionManifest = (familyDir, name, description = '') => {
  const manifestPath = path.join(familyDir, COLLECTION_MANIFEST);
  if (fs.existsSync(manifestPath)) {
    return;
  }
  fs.writeFileSync(manifestPath, yaml.dump({ name, description }), { mode: 0o644 });
};

const readCollection = name => {
  const dir = path.join(getRegistryDir(), name);
  const manifestPath = path.join(dir, COLLECTION_MANIFEST);

  const collection = {
    name,
    description: '',
    valid: false,
    metadata: null,
    versions: [],
    source: readFamilySource(name),
  };
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = readManifest(manifestPath);
      collection.metadata = manifest;
      collection.description = metaString(manifest, 'description');
    } catch (error) {
      collection.description = `invalid ${COLLECTION_MANIFEST}: ${error.message}`;
    }
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidPackageName(entry.name)) {
      continue;
    }
    const root = path.join(dir, entry.name);
    let versionDoc;
    try {
      versionDoc = readManifest(path.join(root, VERSION_MANIFEST));
    } catch {
      continue;
    }
    if (!versionDoc || typeof versionDoc !== 'object') {
      continue;
    }
    collection.versions.push({
      version: metaString(versionDoc, 'version') || entry.name,
      dir: entry.name,
      name: metaString(versionDoc, 'name'),
      description: metaString(versionDoc, 'description'),
      root,
      metadata: versionDoc,
    });
  }

  collection.versions.sort((x, y) => compareVersions(y.version, x.version));
  collection.valid = collection.versions.length > 0;
  if (!fs.existsSync(manifestPath)) {
    if (!collection.valid) {
      return null;
    }
    synthesizeCollectionManifest(dir, name);
  }
  return collection;
};

export const listCollections = () => {
  const dir = getRegistryDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  const collections = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidPackageName(entry.name)) {
      continue;
    }
    try {
      const collection = readCollection(entry.name);
      if (collection) {
        collections.push(collection);
      }
    } catch (error) {
      log.api.warn('Skipping unreadable provisioner', { name: entry.name, error: error.message });
    }
  }
  collections.sort((x, y) => x.name.localeCompare(y.name));
  return collections;
};

export const getCollection = name => {
  if (!isValidPackageName(name)) {
    return null;
  }
  return readCollection(name);
};

/**
 * The derived role-specs cache — OURS, not the package's: role argument specs
 * folded from every shipped role's meta/argument_specs.yml (the source of
 * truth). Lives BESIDE provisioner.yml in the version dir; rewriting
 * provisioner.yml itself would re-serialize the package manifest and destroy
 * its comments/release stamp. Rebuilt at import and by the refresh endpoint.
 */
export const ROLE_SPECS_FILE = 'role-specs.yml';

const collectRoleSpecs = (rolesDir, collectionId, roles) => {
  for (const role of fs.readdirSync(rolesDir, { withFileTypes: true })) {
    if (!role.isDirectory()) {
      continue;
    }
    const specFile = path.join(rolesDir, role.name, 'meta', 'argument_specs.yml');
    if (!fs.existsSync(specFile)) {
      continue;
    }
    try {
      const doc = yaml.load(fs.readFileSync(specFile, 'utf8'));
      const main = doc?.argument_specs?.main;
      if (!main || typeof main !== 'object') {
        continue;
      }
      roles[role.name] = {
        collection: collectionId,
        short_description: typeof main.short_description === 'string' ? main.short_description : '',
        options: main.options && typeof main.options === 'object' ? main.options : {},
      };
    } catch (error) {
      log.api.warn('Skipping unparseable argument_specs', {
        role: role.name,
        error: error.message,
      });
    }
  }
};

/**
 * Walk the version's shipped ansible_collections and fold every role's
 * argument specs into one object.
 * @param {string} versionRoot - Version directory
 * @returns {Object} roles map (empty when nothing ships specs)
 */
const deriveRoleSpecs = versionRoot => {
  const roles = {};
  const collectionsDir = path.join(versionRoot, 'provisioners', 'ansible_collections');
  if (!fs.existsSync(collectionsDir)) {
    return roles;
  }
  for (const ns of fs.readdirSync(collectionsDir, { withFileTypes: true })) {
    if (!ns.isDirectory()) {
      continue;
    }
    const nsDir = path.join(collectionsDir, ns.name);
    for (const coll of fs.readdirSync(nsDir, { withFileTypes: true })) {
      if (!coll.isDirectory()) {
        continue;
      }
      const rolesDir = path.join(nsDir, coll.name, 'roles');
      if (fs.existsSync(rolesDir)) {
        collectRoleSpecs(rolesDir, `${ns.name}.${coll.name}`, roles);
      }
    }
  }
  return roles;
};

/**
 * (Re)build the version's role-specs.yml from the shipped specs. A version
 * with no specs loses any stale cache file.
 * @param {string} versionRoot - Version directory
 * @returns {number} Number of roles cached
 */
export const buildRoleSpecs = versionRoot => {
  const roles = deriveRoleSpecs(versionRoot);
  const count = Object.keys(roles).length;
  const file = path.join(versionRoot, ROLE_SPECS_FILE);
  if (count > 0) {
    fs.writeFileSync(file, yaml.dump({ roles }), { mode: 0o644 });
  } else if (fs.existsSync(file)) {
    fs.rmSync(file, { force: true });
  }
  return count;
};

/**
 * Read the version's role-specs cache; a missing cache (hand-dropped
 * package) builds it on the spot.
 * @param {string} versionRoot - Version directory
 * @returns {Object|null} { roles } or null when the package ships no specs
 */
export const readRoleSpecs = versionRoot => {
  const file = path.join(versionRoot, ROLE_SPECS_FILE);
  if (!fs.existsSync(file)) {
    return buildRoleSpecs(versionRoot) > 0 ? readRoleSpecs(versionRoot) : null;
  }
  try {
    return yaml.load(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    log.api.warn('Unreadable role-specs cache', { file, error: error.message });
    return null;
  }
};

/**
 * The derived answers JSON Schema (2020-12) — cached beside role-specs.yml
 * (provisioning-design §3.1 derived interop: API validation, editor tooling,
 * catalog embedding). Authors never write it; imports derive it and reads
 * self-heal hand-dropped packages.
 */
export const FIELD_SCHEMA_FILE = 'schema.json';

/**
 * (Re)derive a version's schema.json from its manifest's field DSL. A
 * version with no fields loses any stale cache file.
 * @param {string} versionRoot - Version directory
 * @param {Object} versionDoc - The version's provisioner.yml document
 * @returns {boolean} Whether a schema file exists after the build
 */
export const buildFieldSchema = (versionRoot, versionDoc) => {
  const configuration = versionDoc?.metadata?.configuration;
  const file = path.join(versionRoot, FIELD_SCHEMA_FILE);
  const fields = Array.isArray(configuration?.fields) ? configuration.fields : [];
  if (fields.length > 0) {
    fs.writeFileSync(file, `${JSON.stringify(deriveJsonSchema(configuration), null, 2)}\n`, {
      mode: 0o644,
    });
    return true;
  }
  if (fs.existsSync(file)) {
    fs.rmSync(file, { force: true });
  }
  return false;
};

/**
 * Read a version's cached answers schema; a missing cache (hand-dropped
 * package) derives it on the spot.
 * @param {string} versionRoot - Version directory
 * @param {Object} versionDoc - The version's provisioner.yml document
 * @returns {Object|null} JSON Schema document or null (no field DSL)
 */
export const readFieldSchema = (versionRoot, versionDoc) => {
  const file = path.join(versionRoot, FIELD_SCHEMA_FILE);
  if (!fs.existsSync(file)) {
    return buildFieldSchema(versionRoot, versionDoc)
      ? readFieldSchema(versionRoot, versionDoc)
      : null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    log.api.warn('Unreadable field-schema cache', { file, error: error.message });
    return null;
  }
};

/**
 * Re-derive BOTH per-version caches — role-specs.yml AND the field-DSL
 * schema.json (the shared refresh-specs wire: refreshed[] carries `fields`)
 * — the manual refresh for hand-dropped packages and updated specs.
 * @returns {Array<{name: string, version: string, roles: number, fields: boolean}>}
 */
export const refreshAllRoleSpecs = () => {
  const refreshed = [];
  for (const collection of listCollections()) {
    for (const entry of collection.versions) {
      refreshed.push({
        name: collection.name,
        version: entry.version,
        roles: buildRoleSpecs(entry.root),
        fields: buildFieldSchema(entry.root, entry.metadata),
      });
    }
  }
  return refreshed;
};

export const getPackageVersion = (name, version) => {
  const collection = getCollection(name);
  if (!collection || !isValidPackageName(version)) {
    return null;
  }
  const entry = collection.versions.find(v => v.version === version || v.dir === version) || null;
  if (entry) {
    entry.role_specs = readRoleSpecs(entry.root);
    entry.field_schema = readFieldSchema(entry.root, entry.metadata);
  }
  return entry;
};

export const deleteCollection = name => {
  const collection = getCollection(name);
  if (!collection) {
    return false;
  }
  fs.rmSync(path.join(getRegistryDir(), name), { recursive: true, force: true });
  return true;
};

export const deletePackageVersion = (name, version) => {
  const entry = getPackageVersion(name, version);
  if (!entry) {
    return false;
  }
  fs.rmSync(entry.root, { recursive: true, force: true });
  return true;
};
