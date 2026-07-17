import crypto from 'crypto';
import fs from 'fs';
import { log } from './Logger.js';

/**
 * The one streaming hash implementation: yields to the event loop between
 * chunks (setImmediate) so large files never block the API thread.
 * @param {string} filePath - Path to file
 * @param {string} algorithm - Hash algorithm
 * @param {number} chunkSize - Chunk size in bytes
 * @param {Function|null} onProgress - Callback (bytesRead, totalBytes) => void
 * @returns {Promise<string>} Hex digest
 */
const hashFile = (filePath, algorithm, chunkSize, onProgress) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const totalBytes = onProgress ? fs.statSync(filePath).size : 0;
    let bytesRead = 0;

    const stream = fs.createReadStream(filePath, { highWaterMark: chunkSize });

    stream.on('data', chunk => {
      // Pause, hash synchronously, then yield to the event loop before
      // resuming — this prevents blocking the main thread on large files.
      stream.pause();
      hash.update(chunk);
      bytesRead += chunk.length;
      if (onProgress) {
        onProgress(bytesRead, totalBytes);
      }
      setImmediate(() => stream.resume());
    });

    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });

/**
 * Calculate file checksum with non-blocking behavior
 * @param {string} filePath - Path to file
 * @param {string} algorithm - Hash algorithm (default: sha256)
 * @param {number} chunkSize - Chunk size in bytes (default: 2MB)
 * @returns {Promise<string>} Hex digest of checksum
 */
export const calculateChecksum = async (
  filePath,
  algorithm = 'sha256',
  chunkSize = 2 * 1024 * 1024
) => {
  try {
    const checksum = await hashFile(filePath, algorithm, chunkSize, null);
    log.task.debug('Checksum calculation completed', {
      file: filePath,
      algorithm,
      checksum: `${checksum.substring(0, 16)}...`,
    });
    return checksum;
  } catch (err) {
    log.task.error('Checksum calculation failed', {
      file: filePath,
      error: err.message,
    });
    throw err;
  }
};

/**
 * Calculate checksum with progress callback
 * @param {string} filePath - Path to file
 * @param {string} algorithm - Hash algorithm
 * @param {Function} onProgress - Callback (bytesRead, totalBytes) => void
 * @returns {Promise<string>} Hex digest of checksum
 */
export const calculateChecksumWithProgress = (filePath, algorithm = 'sha256', onProgress = null) =>
  hashFile(filePath, algorithm, 2 * 1024 * 1024, onProgress);
