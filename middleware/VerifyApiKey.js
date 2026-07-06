import bcrypt from 'bcrypt';
import crypto from 'crypto';
import Entities from '../models/EntityModel.js';
import { log } from '../lib/Logger.js';

/**
 * @fileoverview API Key verification middleware for Zoneweaver Agent
 * @description Validates API keys of the form `hw_<key_id>.<secret>`: the key_id
 * selects the entity row directly, so verification costs exactly ONE bcrypt
 * compare — never a compare against every stored hash. Verified keys are cached
 * in memory (sha256 of the presented key), so repeat requests skip bcrypt and
 * the database entirely. Also enforces the Agent API v1 direct-mode role model
 * (viewer < operator < admin) via a central method+path policy.
 */

/**
 * API key shape: hw_ prefix, 16-char base64url key_id, dot, base64url secret.
 * @type {RegExp}
 */
const API_KEY_PATTERN = /^hw_(?<keyId>[A-Za-z0-9_-]{16})\.[A-Za-z0-9_-]+$/;

/**
 * How long a cached verification may satisfy requests before the entity's
 * last_used column is refreshed in the database.
 * @type {number}
 */
const LAST_USED_FLUSH_MS = 60000;

/**
 * Verified-key cache: sha256(presented key) → {id, name, description, role,
 * lastUsedFlush}. Only SUCCESSFUL verifications are cached (a flood of bogus
 * keys cannot grow it), and every mutation path (revoke/delete) purges through
 * purgeApiKeyCacheEntry, so entries never outlive their entity's validity.
 * @type {Map<string, {id: number, name: string, description: string|null, role: string, lastUsedFlush: number}>}
 */
const verifiedKeyCache = new Map();

/**
 * Remove any cached verifications for an entity (call on revoke/delete).
 * @param {number} entityId - Entity whose cached keys must be dropped
 * @returns {void}
 */
export const purgeApiKeyCacheEntry = entityId => {
  for (const [hash, entry] of verifiedKeyCache) {
    if (entry.id === entityId) {
      verifiedKeyCache.delete(hash);
    }
  }
};

/**
 * Role hierarchy for the direct-mode authorization model (Agent API v1).
 * Unknown/legacy roles compare as 0 and only pass checks requiring nothing.
 */
const ROLE_LEVELS = { viewer: 1, operator: 2, admin: 3 };

/**
 * Admin-only surfaces for MUTATING requests: host power/init, system account
 * management, database maintenance, server restart. (Reads on these stay
 * viewer-accessible — e.g. GET /system/host/status.)
 */
const ADMIN_WRITE_PREFIXES = [
  '/server',
  '/system/host',
  '/system/users',
  '/system/groups',
  '/system/roles',
  '/database',
];

/**
 * Surfaces that are admin-only regardless of method: key management (listing
 * keys is admin metadata) and agent settings (GET /settings can expose
 * registry credentials and host paths).
 */
const ADMIN_ALWAYS_PREFIXES = ['/api-keys', '/settings'];

/**
 * Check whether a request path falls under a prefix (exact or subpath).
 * @param {string} path - Request path
 * @param {string[]} prefixes - Path prefixes
 * @returns {boolean} True when the path is under one of the prefixes
 */
const underPrefix = (path, prefixes) =>
  prefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`));

/**
 * Determine the minimum role a request requires (central policy, Agent API v1):
 * - `/api-keys/info` (self-identification) — any valid key.
 * - `/api-keys/*` + `/settings/*` — admin, all methods.
 * - `/ws-ticket` — operator (tickets are unbound and open console WebSockets).
 * - `/filesystem/*` — operator, all methods (reads return host file contents).
 * - other GET/HEAD — viewer.
 * - other mutations — operator; admin on ADMIN_WRITE_PREFIXES.
 * @param {string} method - HTTP method
 * @param {string} path - Request path
 * @returns {string} Minimum role: viewer | operator | admin
 */
const requiredRole = (method, path) => {
  if (path === '/api-keys/info') {
    return 'viewer';
  }
  if (underPrefix(path, ADMIN_ALWAYS_PREFIXES)) {
    return 'admin';
  }
  if (path === '/ws-ticket' || underPrefix(path, ['/filesystem'])) {
    return 'operator';
  }
  if (method === 'GET' || method === 'HEAD') {
    return 'viewer';
  }
  if (underPrefix(path, ADMIN_WRITE_PREFIXES)) {
    return 'admin';
  }
  return 'operator';
};

/**
 * Verify the presented key against the entity selected by its key_id.
 * @param {string} apiKey - Full presented API key
 * @returns {Promise<Object|null>} Cache entry for a valid key, null otherwise
 */
const verifyAgainstDatabase = async apiKey => {
  const match = API_KEY_PATTERN.exec(apiKey);
  if (!match) {
    return null;
  }

  const entity = await Entities.findOne({
    where: { key_id: match.groups.keyId, is_active: true },
  });
  if (!entity) {
    return null;
  }

  const isValid = await bcrypt.compare(apiKey, entity.api_key_hash);
  if (!isValid) {
    return null;
  }

  return {
    id: entity.id,
    name: entity.name,
    description: entity.description,
    role: entity.role || 'admin',
    lastUsedFlush: 0,
  };
};

/**
 * Middleware to verify API key authentication
 * @description Validates the API key from the X-API-Key or Authorization: Bearer
 * header (cache-first, one bcrypt compare on a miss), refreshes last_used at
 * most once per minute per key, and adds entity information to the request.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 *
 * @example
 * // Usage in routes
 * router.get('/protected', verifyApiKey, (req, res) => {
 *   // req.entity contains validated entity information
 *   log.auth.info('Authenticated request', { entity: req.entity.name });
 * });
 *
 * @example
 * // Expected Authorization header format
 * Authorization: Bearer hw_<key_id>.<secret>
 */
export const verifyApiKey = async (req, res, next) => {
  // Support both X-API-Key and Authorization: Bearer formats
  let apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    const authHeader = req.headers.authorization;
    apiKey = authHeader && authHeader.split(' ')[1];
  }

  try {
    if (!apiKey) {
      return res.status(401).json({
        msg: 'API key required - provide either X-API-Key header or Authorization: Bearer header',
      });
    }

    const cacheKey = crypto.createHash('sha256').update(apiKey).digest('hex');
    let entry = verifiedKeyCache.get(cacheKey);

    if (!entry) {
      entry = await verifyAgainstDatabase(apiKey);
      if (!entry) {
        return res.status(403).json({ msg: 'Invalid API key' });
      }
      verifiedKeyCache.set(cacheKey, entry);
    }

    // Enforce the direct-mode role model (Agent API v1).
    const needed = requiredRole(req.method, req.path);
    if ((ROLE_LEVELS[entry.role] || 0) < ROLE_LEVELS[needed]) {
      log.auth.warn('API key role insufficient for request', {
        entity_name: entry.name,
        role: entry.role,
        required_role: needed,
        request_path: req.path,
        request_method: req.method,
      });
      return res.status(403).json({
        msg: `Insufficient role: this operation requires '${needed}' (key role: '${entry.role}')`,
      });
    }

    // Refresh last_used lazily — at most one write per key per flush window,
    // instead of a database write on every authenticated request.
    const now = Date.now();
    if (now - entry.lastUsedFlush > LAST_USED_FLUSH_MS) {
      entry.lastUsedFlush = now;
      Entities.update({ last_used: new Date() }, { where: { id: entry.id } }).catch(error => {
        log.auth.warn('Failed to refresh last_used', {
          entity_id: entry.id,
          error: error.message,
        });
      });
    }

    // Add entity info to request for logging/audit
    req.entity = {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      role: entry.role,
    };

    return next();
  } catch (error) {
    log.auth.error('API key validation failed', {
      error: error.message,
      stack: error.stack,
      api_key_provided: !!apiKey,
      request_path: req.path,
      request_method: req.method,
    });
    return res.status(500).json({ msg: 'API key validation failed' });
  }
};
