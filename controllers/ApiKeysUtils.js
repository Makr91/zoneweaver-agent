import Entities from '../models/EntityModel.js';
import crypto from 'crypto';
import { Op } from 'sequelize';
import config from '../config/ConfigLoader.js';

export const VALID_ROLES = ['admin', 'operator', 'viewer'];

/**
 * Guard against locking the agent out of administration: true when the given
 * entity is the last ACTIVE admin key.
 * @param {import('sequelize').Model} entity - Entity being deleted/revoked
 * @returns {Promise<boolean>} True if no other active admin key exists
 */
export const isLastActiveAdmin = async entity => {
  if ((entity.role || 'admin') !== 'admin' || !entity.is_active) {
    return false;
  }
  const otherAdmins = await Entities.count({
    where: {
      is_active: true,
      role: 'admin',
      id: { [Op.ne]: entity.id },
    },
  });
  return otherAdmins === 0;
};

export const generateApiKeyCredentials = () => {
  const apiKeyConfig = config.get('api_keys') || { key_length: 64 };
  const keyId = crypto.randomBytes(12).toString('base64url');
  const secret = crypto.randomBytes(apiKeyConfig.key_length || 64).toString('base64url');
  return { keyId, apiKey: `hw_${keyId}.${secret}` };
};
