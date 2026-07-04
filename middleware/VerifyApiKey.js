import bcrypt from 'bcrypt';
import Entities from '../models/EntityModel.js';
import { log } from '../lib/Logger.js';

/**
 * @fileoverview API Key verification middleware for Zoneweaver Agent
 * @description Validates API keys provided in Authorization header, adds entity
 * information to the request, and enforces the Agent API v1 direct-mode role
 * model (viewer < operator < admin) via a central method+path policy.
 */

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
 * Middleware to verify API key authentication
 * @description Validates API key from Authorization header, updates last_used timestamp, and adds entity info to request
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
 * Authorization: Bearer wh_abc123def456...
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

    // Find entity with matching API key hash (parallel execution for performance)
    const entities = await Entities.findAll({
      where: { is_active: true },
    });

    // Use Promise.all for parallel password checking (10x performance improvement)
    const validationPromises = entities.map(async entity => {
      const isValid = await bcrypt.compare(apiKey, entity.api_key_hash);
      return isValid ? entity : null;
    });

    const validationResults = await Promise.all(validationPromises);
    const validEntity = validationResults.find(entity => entity !== null);

    if (!validEntity) {
      return res.status(403).json({ msg: 'Invalid API key' });
    }

    // Enforce the direct-mode role model (Agent API v1). Legacy rows without a
    // role are admin — the flat super-admin behavior they were created under.
    const role = validEntity.role || 'admin';
    const needed = requiredRole(req.method, req.path);
    if ((ROLE_LEVELS[role] || 0) < ROLE_LEVELS[needed]) {
      log.auth.warn('API key role insufficient for request', {
        entity_name: validEntity.name,
        role,
        required_role: needed,
        request_path: req.path,
        request_method: req.method,
      });
      return res.status(403).json({
        msg: `Insufficient role: this operation requires '${needed}' (key role: '${role}')`,
      });
    }

    // Update last_used timestamp
    await validEntity.update({ last_used: new Date() });

    // Add entity info to request for logging/audit
    req.entity = {
      id: validEntity.id,
      name: validEntity.name,
      description: validEntity.description,
      role,
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
