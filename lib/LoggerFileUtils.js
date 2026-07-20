import fs from 'fs';
import zlib from 'zlib';

/**
 * Compress a file with gzip and remove the original
 * @param {string} filePath - Path to compress
 */
export const compressFile = async filePath => {
  try {
    const compressedPath = `${filePath}.gz`;

    if (fs.existsSync(compressedPath)) {
      return;
    }

    const readStream = fs.createReadStream(filePath);
    const writeStream = fs.createWriteStream(compressedPath);
    const gzip = zlib.createGzip();

    await new Promise((resolve, reject) => {
      readStream.pipe(gzip).pipe(writeStream).on('finish', resolve).on('error', reject);
    });

    await fs.promises.unlink(filePath);
  } catch {
    void 0;
  }
};
