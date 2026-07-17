/**
 * @fileoverview Provisioner package import executor (provisioner_import task)
 * @description Resolves a folder, archive, or git source to a directory, finds the package
 * root (SHI's 3-level search), and copies versions into the registry — never touching
 * versions already present. Mirrors the Go agent's internal/provisioner import executor.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import { executeCommand } from '../../lib/CommandManager.js';
import { calculateChecksum } from '../../lib/ChecksumHelper.js';
import { log } from '../../lib/Logger.js';
import { updateTaskProgress, parseTaskMetadata } from '../../lib/TaskProgressHelper.js';
import {
  COLLECTION_MANIFEST,
  VERSION_MANIFEST,
  getRegistryDir,
  isValidPackageName,
  synthesizeCollectionManifest,
  buildRoleSpecs,
  buildFieldSchema,
  recordFamilySource,
} from '../../lib/ProvisionerRegistry.js';
import { lintConfiguration, formatLintErrors } from '../../lib/FieldDslLint.js';
import {
  findCatalogSource,
  fetchCatalog,
  findCatalogArtifact,
  catalogSourceError,
} from '../../lib/ProvisionerCatalog.js';
import { getGitToken } from '../../lib/SecretsStore.js';
import yaml from 'js-yaml';

const ROOT_SEARCH_DEPTH = 3;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
/** The secrets store's entry-name rule (shared wire with the Go agent). */
export const TOKEN_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/u;

const isArchive = file =>
  file.endsWith('.tar.gz') || file.endsWith('.tgz') || file.endsWith('.zip');

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
    // Fail-closed: one bad manifest refuses the whole import — never a
    // silent skip of a version the author shipped.
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
 * Verify an archive's sha256 against the expected checksum (share uploads +
 * catalog imports, design §7: verify sha256 after download, THEN import).
 * @param {string} archivePath - Archive file
 * @param {string} expected - Expected hex digest ('' skips)
 * @param {Function|null} onData - Output sink
 */
const verifyArchiveChecksum = async (archivePath, expected, onData) => {
  if (!expected) {
    return;
  }
  onData?.({ stream: 'stdout', data: `Verifying sha256 of ${path.basename(archivePath)}\n` });
  const actual = await calculateChecksum(archivePath, 'sha256');
  if (actual.toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(
      `checksum mismatch on ${path.basename(archivePath)}: expected ${expected}, got ${actual} — refusing to import`
    );
  }
  onData?.({ stream: 'stdout', data: 'Checksum verified\n' });
};

/**
 * Extract an archive into a fresh temp dir (shared by the archive and url
 * sources).
 * @param {string} archivePath - Archive file
 * @param {Function|null} onData - Output sink
 * @returns {Promise<{dir: string, cleanup: Function}>}
 */
const extractArchive = async (archivePath, onData) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-provisioner-import-'));
  onData?.({ stream: 'stdout', data: `Extracting ${path.basename(archivePath)}\n` });
  const command = archivePath.endsWith('.zip')
    ? `unzip -q "${archivePath}" -d "${temp}"`
    : `tar -xzf "${archivePath}" -C "${temp}"`;
  const result = await executeCommand(command, 600000, onData);
  if (!result.success) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw new Error(`archive extraction failed: ${result.error}`);
  }
  return { dir: temp, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
};

/**
 * Download a catalog artifact to a temp file. The URL is OPAQUE (release
 * tags carry slashes) — only the basename is inspected, for the archive-type
 * check.
 * @param {string} url - Artifact URL (http/https)
 * @param {Function|null} onData - Output sink
 * @returns {Promise<{file: string, cleanupDir: string}>}
 */
const downloadArtifact = async (url, onData) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('url must be an http(s) artifact URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('url must be an http(s) artifact URL');
  }
  const baseName =
    decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '') || 'package.tar.gz';
  if (!isArchive(baseName)) {
    throw new Error(`catalog artifact must be a .tar.gz, .tgz, or .zip file (got ${baseName})`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-provisioner-download-'));
  const file = path.join(dir, baseName);
  onData?.({ stream: 'stdout', data: `Downloading ${url}\n` });
  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 60000,
    maxRedirects: 5,
    headers: { 'User-Agent': 'Zoneweaver/1.0.0' },
  });
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(file);
    response.data.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);
    response.data.on('error', reject);
  });
  return { file, cleanupDir: dir };
};

const resolveSource = async (metadata, onData) => {
  const { source_type, path: sourcePath, url, branch, checksum } = metadata;

  if (source_type === 'folder') {
    if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
      throw new Error(`source folder does not exist: ${sourcePath}`);
    }
    return { dir: sourcePath, cleanup: null };
  }

  if (source_type === 'archive') {
    if (!sourcePath || !isArchive(sourcePath)) {
      throw new Error('archive must be a .tar.gz, .tgz, or .zip file');
    }
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`archive does not exist: ${sourcePath}`);
    }
    await verifyArchiveChecksum(sourcePath, checksum, onData);
    return extractArchive(sourcePath, onData);
  }

  if (source_type === 'git') {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('url must be an http(s) git repository URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('url must be an http(s) git repository URL');
    }
    if (branch && !BRANCH_PATTERN.test(branch)) {
      throw new Error('branch contains unsupported characters');
    }
    if (metadata.token_name && !TOKEN_NAME_PATTERN.test(metadata.token_name)) {
      throw new Error('token_name contains unsupported characters');
    }

    // Private repositories (Mark's ruling): token_name NAMES a git_api_keys
    // secrets-store entry, resolved HERE at run time — the token rides the
    // clone URL as userinfo (SHI's exact clone shape) and never lands in
    // provenance, task metadata, narration, or logs (logCommand below).
    let cloneUrl = url;
    if (metadata.token_name) {
      const token = getGitToken(metadata.token_name);
      if (!token) {
        throw new Error(`no git API key named ${metadata.token_name} in the secrets store`);
      }
      const withToken = new URL(url);
      withToken.username = token;
      cloneUrl = withToken.toString();
    }

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-provisioner-clone-'));
    const branchArg = branch ? ` --branch "${branch}"` : '';
    const cloneCommand = remote =>
      `git -c core.longpaths=true clone --depth 1 --recursive${branchArg} "${remote}" "${temp}"`;
    onData?.({ stream: 'stdout', data: `Cloning ${url}\n` });
    const result = await executeCommand(
      cloneCommand(cloneUrl),
      900000,
      onData,
      null,
      cloneCommand(url)
    );
    if (!result.success) {
      fs.rmSync(temp, { recursive: true, force: true });
      throw new Error(`git clone failed: ${result.error}`);
    }
    return { dir: temp, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
  }

  throw new Error('source_type must be "folder", "archive", or "git"');
};

/**
 * Import a resolved source directory into the registry (collection or
 * version root, 3-level search) — shared by the import task and the
 * catalog-install task.
 * @param {string} dir - Resolved source directory
 * @param {Function|null} onData - Output sink
 * @returns {string} The imported family name
 */
const importFromDirectory = (dir, onData) => {
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

/**
 * Catalog install executor (op provisioner_catalog_install — the Go agent's
 * wire): FRESH catalog fetch at RUN time (stale pins 404 anyway; published
 * checksums never change), versioned-asset download, sha256 verified before
 * anything lands, then the ordinary import path (lint gate + non-clobber
 * included).
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeProvisionerCatalogInstallTask = async task => {
  try {
    const metadata = await parseTaskMetadata(task);
    const { source_name, name, version } = metadata;
    const { onData } = task;

    const source = findCatalogSource(source_name);
    if (!source) {
      return { success: false, error: catalogSourceError(source_name) };
    }

    await updateTaskProgress(task, 10, { status: 'fetching_catalog' });
    onData?.({ stream: 'stdout', data: `Fetching catalog ${source.url}\n` });
    const catalog = await fetchCatalog(source);
    const artifact = findCatalogArtifact(catalog, name, version);
    if (!artifact) {
      return {
        success: false,
        error: `${name}/${version} is not in catalog '${source.name}' (versions may disappear when authors delete releases)`,
      };
    }

    await updateTaskProgress(task, 25, { status: 'downloading' });
    const { file, cleanupDir } = await downloadArtifact(artifact.url, onData);
    try {
      await updateTaskProgress(task, 55, { status: 'verifying' });
      await verifyArchiveChecksum(file, artifact.checksum, onData);
      const extracted = await extractArchive(file, onData);
      try {
        await updateTaskProgress(task, 75, { status: 'importing_package' });
        importFromDirectory(extracted.dir, onData);
      } finally {
        extracted.cleanup();
      }
    } finally {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
    }

    await updateTaskProgress(task, 100, { status: 'completed' });
    return { success: true, message: `Catalog install completed: ${name}/${version}` };
  } catch (error) {
    log.task.error('Catalog install failed', { error: error.message });
    return { success: false, error: `Catalog install failed: ${error.message}` };
  }
};

export const executeProvisionerImportTask = async task => {
  let metadata = null;
  try {
    metadata = await parseTaskMetadata(task);
    const { onData } = task;

    await updateTaskProgress(task, 10, { status: 'resolving_source' });
    const { dir, cleanup } = await resolveSource(metadata, onData);

    try {
      await updateTaskProgress(task, 60, { status: 'importing_package' });
      const familyName = importFromDirectory(dir, onData);
      // git imports record their provenance per FAMILY (registry-side,
      // never inside the package files) so refresh-from-source can re-run
      // the ordinary import against the same repo later. token_name NAMES
      // the secrets-store entry — the token itself never lands here.
      if (metadata.source_type === 'git') {
        recordFamilySource(familyName, {
          source_type: 'git',
          url: metadata.url,
          ...(metadata.branch ? { branch: metadata.branch } : {}),
          ...(metadata.token_name ? { token_name: metadata.token_name } : {}),
        });
        onData?.({
          stream: 'stdout',
          data: `Recorded git provenance for ${familyName} (refresh-from-source enabled)\n`,
        });
      }
    } finally {
      cleanup?.();
    }

    await updateTaskProgress(task, 100, { status: 'completed' });
    return { success: true, message: 'Provisioner import completed' };
  } catch (error) {
    log.task.error('Provisioner import failed', { error: error.message });
    return { success: false, error: `Provisioner import failed: ${error.message}` };
  } finally {
    // Share uploads land in a temp dir the task owns — remove the archive
    // whether the import succeeded or refused. Only OUR upload-staging dirs
    // are removed recursively; anything else loses just the file.
    if (metadata?.cleanup_source && metadata.path && fs.existsSync(metadata.path)) {
      const parent = path.dirname(metadata.path);
      if (path.basename(parent).startsWith('zw-provisioner-upload-')) {
        fs.rmSync(parent, { recursive: true, force: true });
      } else {
        fs.rmSync(metadata.path, { force: true });
      }
    }
  }
};
