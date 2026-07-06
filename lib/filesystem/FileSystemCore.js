/**
 * @fileoverview File System Core Utilities for Zoneweaver Agent
 * @description Shared helpers for secure filesystem operations — MIME detection,
 * command execution, path validation, and binary file detection
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import mimeTypes from 'mime-types';
import config from '../../config/ConfigLoader.js';
import { log } from '../Logger.js';

const execAsync = promisify(exec);

// ALL static limits should be configurable via config.yaml!!

/**
 * Get MIME type using mime-types package
 * @param {string} filePath - File path
 * @returns {string} MIME type
 */
export const getMimeType = filePath => {
  const mimeType = mimeTypes.lookup(filePath);
  return mimeType || 'application/octet-stream';
};

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @param {number} timeout - Timeout in milliseconds
 * timeout should be configurable! remove this comment after fixing
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
export const executeCommand = async (command, timeout = 30000) => {
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer ## Should be configurable, remove comment after fixing
    });

    if (stderr && stderr.trim()) {
      log.filesystem.warn('File command executed with stderr', {
        command: command.substring(0, 100),
        stderr: stderr.trim(),
      });
    }

    return {
      success: true,
      output: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      output: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
};

/**
 * Validate file path for security
 * @param {string} filePath - Path to validate
 * @returns {{valid: boolean, error?: string, normalizedPath?: string}}
 */
export const validatePath = filePath => {
  try {
    const fileBrowserConfig = config.getFileBrowser();

    if (!fileBrowserConfig?.enabled) {
      return { valid: false, error: 'File browser is disabled' };
    }

    // Normalize the path
    const normalizedPath = path.resolve(filePath);

    // Check for directory traversal
    if (fileBrowserConfig.security.prevent_traversal) {
      if (filePath.includes('..') || filePath.includes('~')) {
        return { valid: false, error: 'Directory traversal not allowed' };
      }
    }

    // Check forbidden paths
    for (const forbiddenPath of fileBrowserConfig.security.forbidden_paths) {
      if (normalizedPath.startsWith(forbiddenPath)) {
        return { valid: false, error: `Access to ${forbiddenPath} is forbidden` };
      }
    }

    // Check forbidden patterns
    for (const pattern of fileBrowserConfig.security.forbidden_patterns) {
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      if (regex.test(normalizedPath)) {
        return { valid: false, error: `Path matches forbidden pattern: ${pattern}` };
      }
    }

    return { valid: true, normalizedPath };
  } catch (error) {
    return { valid: false, error: `Path validation error: ${error.message}` };
  }
};

/**
 * Check if file is binary
 * @param {string} filePath - Path to file
 * @returns {Promise<boolean>} True if file appears to be binary
 */
export const isBinaryFile = async filePath => {
  try {
    const fileHandle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await fileHandle.read(buffer, 0, 8192, 0);
    await fileHandle.close();

    if (bytesRead === 0) {
      return false;
    } // Empty file, treat as text

    const sample = buffer.slice(0, bytesRead);

    // Count null bytes - binary files typically have many null bytes
    const nullBytes = sample.filter(byte => byte === 0).length;
    const nullPercentage = nullBytes / bytesRead;

    // Consider binary if >1% null bytes
    if (nullPercentage > 0.01) {
      return true;
    }

    // Check for excessive control characters
    const controlBytes = sample.filter(
      byte =>
        (byte >= 1 && byte <= 8) || // Control chars except \t
        (byte >= 11 && byte <= 12) || // Control chars except \n
        (byte >= 14 && byte <= 31) || // Control chars except \r
        byte === 127 // DEL
    ).length;

    const controlPercentage = controlBytes / bytesRead;

    // Consider binary if >5% control characters
    return controlPercentage > 0.05;
  } catch (error) {
    log.filesystem.warn('Cannot determine file type', {
      file_path: filePath,
      error: error.message,
    });
    return true; // Assume binary if we can't read it
  }
};
