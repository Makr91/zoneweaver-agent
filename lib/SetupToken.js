/**
 * @fileoverview Setup (claim) token for first-key bootstrap
 * @description Proof-of-ownership gate for POST /api-keys/bootstrap. A random token
 * is written to a root-readable file beside the config; the first-key request must
 * echo it back, so only someone who can read files on the host can claim the agent.
 * Closes the install→first-key race (mirrors BoxVault's setup-token pattern).
 */

import fs from 'fs';
import crypto from 'crypto';
import config from '../config/ConfigLoader.js';
import { log } from './Logger.js';

const TOKEN_HEX_LENGTH = 64; // 32 random bytes as hex

/**
 * Read the existing setup token, or generate + persist a new one.
 * Idempotent: a valid existing token is reused (e.g. one seeded by the package).
 * @returns {string|null} The setup token, or null if it could not be written
 */
export const getOrGenerateSetupToken = () => {
  const tokenPath = config.getSetupTokenPath();

  if (fs.existsSync(tokenPath)) {
    try {
      const existing = fs.readFileSync(tokenPath, 'utf8').trim();
      if (existing.length === TOKEN_HEX_LENGTH) {
        return existing;
      }
    } catch (error) {
      log.auth.warn('Could not read existing setup token, regenerating', {
        error: error.message,
      });
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    return token;
  } catch (error) {
    log.auth.error('Failed to write setup token', { error: error.message, path: tokenPath });
    return null;
  }
};

/**
 * Read the current setup token from disk without generating one.
 * @returns {string|null} The token, or null if the file is absent/unreadable
 */
export const readSetupToken = () => {
  const tokenPath = config.getSetupTokenPath();
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return null;
  }
};

/**
 * Constant-time comparison of a supplied token against the stored one.
 * @param {string} supplied - Token from the bootstrap request
 * @returns {boolean} True only if a stored token exists and matches
 */
export const verifySetupToken = supplied => {
  const stored = readSetupToken();
  if (!stored || typeof supplied !== 'string' || supplied.length !== stored.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(stored));
};
