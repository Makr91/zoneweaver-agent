import https from 'https';
import fs from 'fs';
import config from '../../../../config/ConfigLoader.js';
import { isTaskCancelled } from '../../../../lib/TaskContext.js';
import { log } from '../../../../lib/Logger.js';
import { buildRegistryCA } from '../../../../lib/TemplateRegistryUtils.js';
import { updateTaskProgress } from './ProgressHelper.js';

/**
 * @fileoverview Registry upload utilities for template publish
 */

/**
 * Helper to ensure registry structure exists (Box, Version, Provider)
 * @param {Object} client - Axios client
 * @param {string} organization - Organization name
 * @param {string} box_name - Box name
 * @param {string} version - Version
 * @param {string} description - Description
 * @param {string} zone_name - Zone name (for description fallback)
 */
export const ensureRegistryStructure = async (
  client,
  organization,
  box_name,
  version,
  description,
  zone_name
) => {
  const ignoreConflict = e => {
    // 200/201 = success, 400 = duplicate box, 409 = duplicate version/provider/arch
    if (![200, 201, 400, 409].includes(e.response?.status)) {
      throw e;
    }
  };

  await client
    .post(`/api/organization/${organization}/box`, {
      name: box_name,
      description: description || `Exported from ${zone_name || 'file'}`,
      isPublic: false,
    })
    .catch(ignoreConflict);

  await client
    .post(`/api/organization/${organization}/box/${box_name}/version`, {
      versionNumber: version,
      description: description || 'Automated export',
    })
    .catch(ignoreConflict);

  await client
    .post(`/api/organization/${organization}/box/${box_name}/version/${version}/provider`, {
      name: 'zone',
    })
    .catch(ignoreConflict);
};

/**
 * Helper to upload artifact to registry
 * @param {Object} client - Axios client
 * @param {Object} sourceConfig - Source configuration
 * @param {string} token - Auth token
 * @param {Object} registryParams - Registry parameters { organization, box_name, version }
 * @param {string} checksum - File checksum
 * @param {string} uploadFilePath - Path to file to upload
 * @param {Object} task - Task object for progress updates
 */
export const uploadRegistryArtifact = async (
  client,
  sourceConfig,
  token,
  registryParams,
  checksum,
  uploadFilePath,
  task
) => {
  const { organization, box_name, version } = registryParams;
  const ignoreConflict = e => {
    // 200/201 = success, 400 = duplicate box, 409 = duplicate version/provider/arch
    if (![200, 201, 400, 409].includes(e.response?.status)) {
      throw e;
    }
  };

  // Create architecture
  await client
    .post(
      `/api/organization/${organization}/box/${box_name}/version/${version}/provider/zone/architecture`,
      {
        name: 'amd64',
        checksum,
        checksumType: 'SHA256',
      }
    )
    .catch(ignoreConflict);

  // Get upload config
  const templateConfig = config.getTemplateSources();
  const uploadTimeout = (templateConfig.upload?.timeout_seconds || 7200) * 1000;
  const chunkSizeMB = templateConfig.upload?.chunk_size_mb || 100;
  const chunkSize = chunkSizeMB * 1024 * 1024;

  const stats = fs.statSync(uploadFilePath);
  const fileSize = stats.size;
  const totalChunks = Math.ceil(fileSize / chunkSize);

  log.task.info('Starting chunked upload', {
    file_size_mb: Math.round(fileSize / 1024 / 1024),
    chunk_size_mb: chunkSizeMB,
    total_chunks: totalChunks,
  });

  const authHeaders = {};
  if (token) {
    authHeaders.Authorization = `Bearer ${token}`;
  }

  const registryCA = buildRegistryCA(sourceConfig);

  // Parse registry URL
  const url = new URL(sourceConfig.url);
  const uploadPath = `/api/organization/${organization}/box/${box_name}/version/${version}/provider/zone/architecture/amd64/file/upload`;

  /**
   * Upload a single chunk with retry logic
   * @param {number} chunkIndex - Zero-based chunk index
   * @param {Buffer} chunkData - Chunk data to upload
   * @param {number} retryCount - Current retry attempt
   * @returns {Promise<void>}
   */
  const uploadChunk = async (chunkIndex, chunkData, retryCount = 0) => {
    try {
      await new Promise((resolve, reject) => {
        const options = {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: uploadPath,
          method: 'POST',
          headers: {
            'User-Agent': 'Vagrant/2.2.19 Zoneweaver/1.0.0',
            'Content-Type': 'application/octet-stream',
            'Content-Length': chunkData.length,
            'x-file-name': 'vagrant.box',
            'x-checksum': checksum,
            'x-checksum-type': 'SHA256',
            'X-Chunk-Index': chunkIndex.toString(),
            'X-Total-Chunks': totalChunks.toString(),
            ...authHeaders,
          },
          timeout: uploadTimeout,
          ...(registryCA ? { ca: registryCA } : {}),
        };

        const req = https.request(options, res => {
          let responseBody = '';

          res.on('data', chunk => {
            responseBody += chunk.toString();
          });

          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              log.task.debug('Chunk upload successful', {
                chunk_index: chunkIndex,
                status_code: res.statusCode,
              });
              resolve();
            } else if ([400, 409].includes(res.statusCode)) {
              // Duplicate box/version - treat as success
              log.task.debug('Chunk upload conflict (ignored)', {
                chunk_index: chunkIndex,
                status_code: res.statusCode,
              });
              resolve();
            } else {
              reject(
                new Error(
                  `Chunk ${chunkIndex} upload failed: HTTP ${res.statusCode} - ${responseBody}`
                )
              );
            }
          });
        });

        req.on('error', err => {
          reject(err);
        });

        req.on('timeout', () => {
          req.destroy();
          reject(new Error(`Chunk ${chunkIndex} upload timeout after ${uploadTimeout}ms`));
        });

        // Write chunk data
        req.write(chunkData);
        req.end();
      });
    } catch (err) {
      // Retry logic
      if (retryCount < 3) {
        const backoffMs = 2 ** retryCount * 1000; // 1s, 2s, 4s
        log.task.warn('Chunk upload failed, retrying', {
          chunk_index: chunkIndex,
          retry_attempt: retryCount + 1,
          backoff_ms: backoffMs,
          error: err.message,
        });

        await new Promise(resolve => {
          setTimeout(resolve, backoffMs);
        });
        await uploadChunk(chunkIndex, chunkData, retryCount + 1);
        return;
      }

      throw new Error(`Chunk ${chunkIndex} upload failed after 3 retries: ${err.message}`);
    }
  };

  // Upload chunks sequentially (intentional await in loop for sequential uploads)
  const fileHandle = fs.openSync(uploadFilePath, 'r');
  try {
    const uploadNextChunk = async chunkIndex => {
      if (chunkIndex >= totalChunks) {
        return;
      }

      // Cooperative cancel: a running-task cancel stops between chunks
      // instead of pushing the whole artifact.
      if (isTaskCancelled(task?.id)) {
        throw new Error(`Upload cancelled at chunk ${chunkIndex}/${totalChunks}`);
      }

      const offset = chunkIndex * chunkSize;
      const length = Math.min(chunkSize, fileSize - offset);
      const buffer = Buffer.alloc(length);

      // Read chunk from file
      fs.readSync(fileHandle, buffer, 0, length, offset);

      // Upload chunk (sequential by design for reliable uploads)
      await uploadChunk(chunkIndex, buffer);

      // Update progress
      const uploadedBytes = (chunkIndex + 1) * chunkSize;
      const progressPct = 85 + (Math.min(uploadedBytes, fileSize) / fileSize) * 10; // 85-95%

      setImmediate(() => {
        updateTaskProgress(task, Math.round(progressPct), {
          status: 'uploading',
          chunk: `${chunkIndex + 1}/${totalChunks}`,
          uploaded_mb: Math.round(Math.min(uploadedBytes, fileSize) / 1024 / 1024),
          total_mb: Math.round(fileSize / 1024 / 1024),
        });
      });

      await uploadNextChunk(chunkIndex + 1);
    };

    await uploadNextChunk(0);
  } finally {
    fs.closeSync(fileHandle);
  }

  log.task.info('Chunked upload completed', {
    total_chunks: totalChunks,
    file_size_mb: Math.round(fileSize / 1024 / 1024),
  });
};
