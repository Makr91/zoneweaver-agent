import fs from 'fs';
import { createTransferProgress } from '../../../../lib/TaskProgressHelper.js';

/**
 * @fileoverview Template file download utilities
 */

/**
 * Stream a registry download to disk with byte progress — the converged task
 * wire: percent maps bytes into the 10–50% download window; progress_info
 * carries {status: 'downloading', received_bytes, total_bytes|null}. The
 * total comes from Content-Length, falling back to the pre-resolved registry
 * file size (BoxVault file/info); with neither, the byte counter still moves.
 * @param {Object} client - Axios client
 * @param {string} downloadPath - API path
 * @param {string} tempBoxPath - Local temp path
 * @param {Object} task - Task object
 * @param {Object} templateConfig - Template configuration
 * @param {number|null} [knownSize] - Pre-resolved file size in bytes
 * @returns {Promise<number>} Downloaded bytes
 */
export const downloadTemplateFile = async (
  client,
  downloadPath,
  tempBoxPath,
  task,
  templateConfig,
  knownSize = null
) => {
  const downloadTimeout = (templateConfig.download?.timeout_seconds || 3600) * 1000;

  const response = await client.get(downloadPath, {
    responseType: 'stream',
    timeout: downloadTimeout,
  });

  const contentLength = parseInt(response.headers['content-length'], 10);
  const totalBytes =
    Number.isFinite(contentLength) && contentLength > 0 ? contentLength : knownSize;
  const report = createTransferProgress(task, {
    status: 'downloading',
    windowStart: 10,
    windowEnd: 50,
    totalBytes,
  });

  let downloadedBytes = 0;
  const fileStream = fs.createWriteStream(tempBoxPath);

  response.data.on('data', chunk => {
    downloadedBytes += chunk.length;
    report(downloadedBytes);
  });

  response.data.pipe(fileStream);

  await new Promise((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
    response.data.on('error', reject);
  });

  return downloadedBytes;
};
