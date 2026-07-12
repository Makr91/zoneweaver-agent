/**
 * @fileoverview Provisioner package import executor (provisioner_import task)
 * @description Resolves a folder, archive, or git source to a directory, finds the package
 * root (SHI's 3-level search), and copies versions into the registry — never touching
 * versions already present. Mirrors the Go agent's internal/provisioner import executor.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import yj from 'yieldable-json';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import { updateTaskProgress } from '../../lib/TaskProgressHelper.js';
import {
  COLLECTION_MANIFEST,
  VERSION_MANIFEST,
  getRegistryDir,
  isValidPackageName,
  synthesizeCollectionManifest,
  buildRoleSpecs,
} from '../../lib/ProvisionerRegistry.js';
import yaml from 'js-yaml';

const ROOT_SEARCH_DEPTH = 3;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;

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
    try {
      readManifest(path.join(versionRoot, VERSION_MANIFEST));
    } catch {
      continue;
    }
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
    imported++;
  }

  if (imported === 0 && skipped === 0) {
    throw new Error(`collection ${name} holds no importable versions`);
  }
  onData?.({
    stream: 'stdout',
    data: `Import complete: ${imported} version(s) imported, ${skipped} already present\n`,
  });
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
  onData?.({ stream: 'stdout', data: `Import complete: ${name}/${version}\n` });
};

const resolveSource = async (metadata, onData) => {
  const { source_type, path: sourcePath, url, branch } = metadata;

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
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-provisioner-import-'));
    onData?.({ stream: 'stdout', data: `Extracting ${path.basename(sourcePath)}\n` });
    const command = sourcePath.endsWith('.zip')
      ? `unzip -q "${sourcePath}" -d "${temp}"`
      : `tar -xzf "${sourcePath}" -C "${temp}"`;
    const result = await executeCommand(command, 600000, onData);
    if (!result.success) {
      fs.rmSync(temp, { recursive: true, force: true });
      throw new Error(`archive extraction failed: ${result.error}`);
    }
    return { dir: temp, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
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
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-provisioner-clone-'));
    const branchArg = branch ? ` --branch "${branch}"` : '';
    onData?.({ stream: 'stdout', data: `Cloning ${url}\n` });
    const result = await executeCommand(
      `git -c core.longpaths=true clone --depth 1 --recursive${branchArg} "${url}" "${temp}"`,
      900000,
      onData
    );
    if (!result.success) {
      fs.rmSync(temp, { recursive: true, force: true });
      throw new Error(`git clone failed: ${result.error}`);
    }
    return { dir: temp, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
  }

  throw new Error('source_type must be "folder", "archive", or "git"');
};

export const executeProvisionerImportTask = async task => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(task.metadata, (err, result) => (err ? reject(err) : resolve(result)));
    });
    const { onData } = task;

    await updateTaskProgress(task, 10, { status: 'resolving_source' });
    const { dir, cleanup } = await resolveSource(metadata, onData);

    try {
      await updateTaskProgress(task, 60, { status: 'importing_package' });
      const { root, kind } = findPackageRoot(dir);
      if (kind === COLLECTION_MANIFEST) {
        onData?.({ stream: 'stdout', data: `Found provisioner collection at ${root}\n` });
        importCollection(root, onData);
      } else if (kind === VERSION_MANIFEST) {
        onData?.({ stream: 'stdout', data: `Found provisioner version at ${root}\n` });
        importVersion(root, onData);
      } else {
        throw new Error(
          `no ${COLLECTION_MANIFEST} or ${VERSION_MANIFEST} found within ${ROOT_SEARCH_DEPTH} directory levels of the source`
        );
      }
    } finally {
      cleanup?.();
    }

    await updateTaskProgress(task, 100, { status: 'completed' });
    return { success: true, message: 'Provisioner import completed' };
  } catch (error) {
    log.task.error('Provisioner import failed', { error: error.message });
    return { success: false, error: `Provisioner import failed: ${error.message}` };
  }
};
