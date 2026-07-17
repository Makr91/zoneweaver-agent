/**
 * @fileoverview Provisioner package upload middleware (share surface, design §7)
 * @description Dedicated multer instance for POST
 * /provisioning/provisioners/import-upload: ONE archive file into a fresh
 * temp directory, handed to the provisioner_import task (which verifies the
 * optional sha256, extracts, imports, and removes the upload). Deliberately
 * independent of the file-browser upload middleware and its config gate.
 */

import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ARCHIVE_PATTERN = /\.(?:tar\.gz|tgz|zip)$/iu;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    void req;
    void file;
    try {
      cb(null, fs.mkdtempSync(path.join(os.tmpdir(), 'zw-provisioner-upload-')));
    } catch (error) {
      cb(new Error(`upload staging failed: ${error.message}`), false);
    }
  },
  filename: (req, file, cb) => {
    void req;
    cb(null, file.originalname.replace(/[^a-zA-Z0-9._-]/gu, '_'));
  },
});

const fileFilter = (req, file, cb) => {
  void req;
  if (!ARCHIVE_PATTERN.test(file.originalname)) {
    return cb(new Error('provisioner upload must be a .tar.gz, .tgz, or .zip archive'), false);
  }
  return cb(null, true);
};

/**
 * Single-archive upload middleware for the import-upload endpoint
 * (≤ 4 GiB — the shared wire's cap).
 * @param {string} [fieldName] - Multipart field name (default "file")
 * @returns {Function} Express middleware
 */
export const provisionerUploadSingle = (fieldName = 'file') =>
  multer({
    storage,
    fileFilter,
    limits: { files: 1, fileSize: 4 * 1024 * 1024 * 1024 },
  }).single(fieldName);

/**
 * Upload error mapper — multer errors and the archive filter land as 400s.
 * @param {Error} error - Upstream error
 * @param {Object} req - Request
 * @param {Object} res - Response
 * @param {Function} next - Next handler
 * @returns {Object} Error response
 */
export const handleUploadError = (error, req, res, next) => {
  void req;
  if (error) {
    return res.status(400).json({ error: 'Provisioner upload failed', details: error.message });
  }
  return next();
};
