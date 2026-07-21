import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import { calculateChecksum } from '../../../lib/ChecksumHelper.js';
import config from '../../../config/ConfigLoader.js';
import Template from '../../../models/TemplateModel.js';
import {
  getRegistryToken,
  createRegistryClient,
  findSourceConfig,
} from '../../../lib/TemplateRegistryUtils.js';
import { updateTaskProgress } from './utils/ProgressHelper.js';
import { downloadTemplateFile } from './utils/DownloadHelper.js';
import { extractAndImport } from './utils/ExtractionHelper.js';
import { parseAsync } from '../../../lib/AsyncJson.js';

/**
 * @fileoverview Template download task executor
 */

/**
 * Best-effort expected-size lookup from the registry's file/info record
 * (BoxVault carries fileSize there) — keeps byte progress real when the
 * download answer streams without a Content-Length.
 * @param {Object} client - Axios client
 * @param {string} downloadPath - The download API path
 * @returns {Promise<number|null>} File size in bytes, or null when unknown
 */
const resolveRegistryFileSize = async (client, downloadPath) => {
  try {
    const response = await client.get(downloadPath.replace(/\/download$/u, '/info'));
    const fileSize = Number(response.data?.fileSize);
    return Number.isFinite(fileSize) && fileSize > 0 ? fileSize : null;
  } catch (error) {
    log.task.debug('Registry file/info lookup failed — size from Content-Length or unknown', {
      error: error.message,
    });
    return null;
  }
};

/**
 * Execute template download task
 * Downloads a .box from a Vagrant-compatible registry, extracts it, and imports via zfs recv
 * @param {string} metadataJson - Task metadata as JSON string
 * @param {Object} task - The task row (progress updates write it directly)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeTemplateDownloadTask = async (metadataJson, task) => {
  log.task.debug('Template download task starting');

  let tempBoxPath = null;
  let tempExtractDir = null;

  try {
    const metadata = await parseAsync(metadataJson);

    const { source_name, organization, box_name, version, provider, architecture } = metadata;

    log.task.info('Template download task parameters', {
      source_name,
      organization,
      box_name,
      version,
      provider,
      architecture,
    });

    // Download-honesty guard: the download URL embeds the version verbatim —
    // callers resolve 'latest' to a concrete version before queueing.
    if (!version || version === 'latest') {
      return {
        success: false,
        error:
          "Refusing to download non-specific version 'latest' — resolve a concrete version first",
      };
    }

    // Find source configuration
    const sourceConfig = findSourceConfig(source_name);
    if (!sourceConfig) {
      return {
        success: false,
        error: `Template source not found or disabled: ${source_name}`,
      };
    }

    // Check if template already exists locally
    const existing = await Template.findOne({
      where: { source_name, organization, box_name, version, provider, architecture },
    });
    if (existing) {
      return {
        success: false,
        error: `Template already exists locally: ${organization}/${box_name} v${version} (${provider}/${architecture})`,
      };
    }

    await updateTaskProgress(task, 5, { status: 'connecting_to_registry' });

    // Build the download URL following Vagrant-compatible API pattern
    const downloadPath = `/api/organization/${encodeURIComponent(organization)}/box/${encodeURIComponent(box_name)}/version/${encodeURIComponent(version)}/provider/${encodeURIComponent(provider)}/architecture/${encodeURIComponent(architecture)}/file/download`;

    const token = getRegistryToken(sourceConfig);
    const client = createRegistryClient(sourceConfig, token);
    const downloadUrl = `${sourceConfig.url}${downloadPath}`;

    log.task.info('Starting template download', { url: downloadUrl });
    await updateTaskProgress(task, 10, { status: 'downloading', url: downloadUrl });

    const knownSize = await resolveRegistryFileSize(client, downloadPath);

    // Stream download to temp file
    const templateConfig = config.getTemplateSources();

    tempBoxPath = path.join(os.tmpdir(), `template_download_${crypto.randomUUID()}.box`);

    const downloadedBytes = await downloadTemplateFile(
      client,
      downloadPath,
      tempBoxPath,
      task,
      templateConfig,
      knownSize
    );

    await updateTaskProgress(task, 50, { status: 'calculating_checksum' });

    // Calculate checksum (non-blocking to keep API responsive)
    const checksum = await calculateChecksum(tempBoxPath, 'sha256');

    // Build the ZFS dataset path
    const storagePath = templateConfig.local_storage_path || '/data/templates';
    const datasetBase = storagePath.startsWith('/')
      ? storagePath.substring(1).replace(/\//g, '/')
      : storagePath;
    const datasetPath = `${datasetBase}/${organization}/${box_name}/${version}`;

    const { boxMetadata, tempExtractDir: extractDir } = await extractAndImport(
      tempBoxPath,
      datasetPath,
      task
    );
    tempExtractDir = extractDir;

    await updateTaskProgress(task, 95, { status: 'saving_record' });

    // Create database record
    const template = await Template.create({
      source_name,
      organization,
      box_name,
      version,
      provider,
      architecture,
      dataset_path: datasetPath,
      original_filename: `${box_name}-${version}-${provider}-${architecture}.box`,
      size: downloadedBytes,
      checksum,
      checksum_algorithm: 'sha256',
      source_url: downloadUrl,
      downloaded_at: new Date(),
      last_verified: new Date(),
      metadata: boxMetadata,
    });

    await updateTaskProgress(task, 100, { status: 'completed' });

    log.task.info('Template download and import completed', {
      template_id: template.id,
      dataset_path: datasetPath,
      organization,
      box_name,
      version,
      size_mb: Math.round(downloadedBytes / 1024 / 1024),
    });

    return {
      success: true,
      message: `Template '${organization}/${box_name}' v${version} downloaded and imported to ${datasetPath}`,
      template_id: template.id,
      dataset_path: datasetPath,
    };
  } catch (error) {
    log.task.error('Template download task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Template download failed: ${error.message}` };
  } finally {
    // Clean up temp files
    try {
      if (tempBoxPath && fs.existsSync(tempBoxPath)) {
        await fs.promises.unlink(tempBoxPath);
      }
      if (tempExtractDir && fs.existsSync(tempExtractDir)) {
        await executeCommand(`pfexec rm -rf "${tempExtractDir}"`);
      }
    } catch (cleanupError) {
      log.task.warn('Failed to clean up temp files', { error: cleanupError.message });
    }
  }
};
