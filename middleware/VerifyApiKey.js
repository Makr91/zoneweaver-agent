import bcrypt from 'bcrypt';
import Entities from '../models/EntityModel.js';
import { log } from '../lib/Logger.js';

/**
 * @fileoverview API Key verification middleware for Zoneweaver Agent
 * @description Validates API keys provided in Authorization header and adds entity information to request
 */

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

    // Update last_used timestamp
    await validEntity.update({ last_used: new Date() });

    // Add entity info to request for logging/audit
    req.entity = {
      id: validEntity.id,
      name: validEntity.name,
      description: validEntity.description,
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
