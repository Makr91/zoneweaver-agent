import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import {
  COLLECTION_MANIFEST,
  VERSION_MANIFEST,
  getRegistryDir,
  isValidPackageName,
  synthesizeCollectionManifest,
  buildRoleSpecs,
  buildFieldSchema,
} from '../../lib/ProvisionerRegistry.js';
import { lintConfiguration, formatLintErrors } from '../../lib/FieldDslLint.js';

const ROOT_SEARCH_DEPTH = 3;

const readManifest = file => yaml.load(fs.readFileSync(file, 'utf8'));

const findPackageRoot = dir => {
  let versionRoot = '';
  let level = [dir];
  for (let depth = 0; depth <= ROOT_SEARCH_DEPTH; depth++) {
    const next = [];
    for (const candidate of level) {
      if (fs.existsSync(path.join(candidate, COLLECTION_MANIFEST))) {
        return { root: candidate, kind: COLLECTION_MANIFEST };
      }
      if (!versionRoot && fs.existsSync(path.join(candidate, VERSION_MANIFEST))) {
        versionRoot = candidate;
      }
      let entries = [];
      try {
        entries = fs.readdirSync(candidate, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== '.git') {
          next.push(path.join(candidate, entry.name));
        }
      }
    }
    level = next;
  }
  return versionRoot ? { root: versionRoot, kind: VERSION_MANIFEST } : { root: '', kind: '' };
};

const copyTree = (src, dst) => {
  fs.cpSync(src, dst, {
    recursive: true,
    filter: source => path.basename(source) !== '.git',
  });
};

/**
 * Import-time field-DSL schema lint (provisioning-design §3.1, fail-closed):
 * an unknown type/key/grammar error REFUSES the import before anything lands
 * in the registry; the refusal echoes the author's YAML with inline
 * annotations.
 * @param {Object} manifest - The version's provisioner.yml document
 * @param {string} label - "<name>/<version>" for the refusal message
 */
const lintManifestOrThrow = (manifest, label) => {
  const errors = lintConfiguration(manifest?.metadata?.configuration, manifest?.metadata?.roles);
  if (errors.length > 0) {
    throw new Error(
      `${label}: field DSL lint failed (${errors.length} error(s)) — import refused, fix the manifest:\n${formatLintErrors(errors)}`
    );
  }
};

const importCollection = (root, onData) => {
  const manifest = readManifest(path.join(root, COLLECTION_MANIFEST));
  const name = typeof manifest?.name === 'string' ? manifest.name : '';
  if (!isValidPackageName(name)) {
    throw new Error(`collection manifest carries an unusable name "${name}"`);
  }

  const targetDir = path.join(getRegistryDir(), name);
  fs.mkdirSync(targetDir, { recursive: true });
  if (!fs.existsSync(path.join(targetDir, COLLECTION_MANIFEST))) {
    fs.copyFileSync(
      path.join(root, COLLECTION_MANIFEST),
      path.join(targetDir, COLLECTION_MANIFEST)
    );
  }

  let imported = 0;
  let skipped = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidPackageName(entry.name)) {
      continue;
    }
    const versionRoot = path.join(root, entry.name);
    let versionManifest;
    try {
      versionManifest = readManifest(path.join(versionRoot, VERSION_MANIFEST));
    } catch {
      continue;
    }
    lintManifestOrThrow(versionManifest, `${name}/${entry.name}`);
    const target = path.join(targetDir, entry.name);
    if (fs.existsSync(target)) {
      onData?.({
        stream: 'stdout',
        data: `${name}/${entry.name} already present — left untouched\n`,
      });
      skipped++;
      continue;
    }
    onData?.({ stream: 'stdout', data: `Importing ${name}/${entry.name}\n` });
    copyTree(versionRoot, target);
    const specCount = buildRoleSpecs(target);
    if (specCount > 0) {
      onData?.({
        stream: 'stdout',
        data: `Cached argument specs for ${specCount} role(s)\n`,
      });
    }
    if (buildFieldSchema(target, versionManifest)) {
      onData?.({ stream: 'stdout', data: 'Derived answers schema.json from the field DSL\n' });
    }
    imported++;
  }

  if (imported === 0 && skipped === 0) {
    throw new Error(`collection ${name} holds no importable versions`);
  }
  onData?.({
    stream: 'stdout',
    data: `Import complete: ${imported} version(s) imported, ${skipped} already present\n`,
  });
  return name;
};

const importVersion = (root, onData) => {
  const manifest = readManifest(path.join(root, VERSION_MANIFEST));
  const name = typeof manifest?.name === 'string' ? manifest.name : '';
  const version = typeof manifest?.version === 'string' ? manifest.version : '';
  if (!isValidPackageName(name)) {
    throw new Error(`provisioner manifest carries an unusable name "${name}"`);
  }
  if (!isValidPackageName(version)) {
    throw new Error(`provisioner manifest carries an unusable version "${version}"`);
  }
  lintManifestOrThrow(manifest, `${name}/${version}`);

  const familyDir = path.join(getRegistryDir(), name);
  const target = path.join(familyDir, version);
  if (fs.existsSync(target)) {
    throw new Error(
      `${name}/${version} already exists — versions in use are never touched; import a newer version instead`
    );
  }
  fs.mkdirSync(familyDir, { recursive: true });
  synthesizeCollectionManifest(
    familyDir,
    name,
    typeof manifest?.description === 'string' ? manifest.description : ''
  );

  onData?.({ stream: 'stdout', data: `Importing ${name}/${version}\n` });
  copyTree(root, target);
  const specCount = buildRoleSpecs(target);
  if (specCount > 0) {
    onData?.({ stream: 'stdout', data: `Cached argument specs for ${specCount} role(s)\n` });
  }
  if (buildFieldSchema(target, manifest)) {
    onData?.({ stream: 'stdout', data: 'Derived answers schema.json from the field DSL\n' });
  }
  onData?.({ stream: 'stdout', data: `Import complete: ${name}/${version}\n` });
  return name;
};

/**
 * Import a resolved source directory into the registry (collection or
 * version root, 3-level search) — shared by the import task and the
 * catalog-install task.
 * @param {string} dir - Resolved source directory
 * @param {Function|null} onData - Output sink
 * @returns {string} The imported family name
 */
export const importFromDirectory = (dir, onData) => {
  const { root, kind } = findPackageRoot(dir);
  if (kind === COLLECTION_MANIFEST) {
    onData?.({ stream: 'stdout', data: `Found provisioner collection at ${root}\n` });
    return importCollection(root, onData);
  }
  if (kind === VERSION_MANIFEST) {
    onData?.({ stream: 'stdout', data: `Found provisioner version at ${root}\n` });
    return importVersion(root, onData);
  }
  throw new Error(
    `no ${COLLECTION_MANIFEST} or ${VERSION_MANIFEST} found within ${ROOT_SEARCH_DEPTH} directory levels of the source`
  );
};
