/**
 * @fileoverview Provisioning request validation helper
 */

import Recipes from '../../../models/RecipeModel.js';
import { validateZoneName } from '../../../lib/ZoneValidation.js';
import { log } from '../../../lib/Logger.js';

/**
 * Validate provisioning request and zone state (Hosts.yml structure:
 * provisioner + settings/networks)
 * @param {string} zoneName - Zone name
 * @param {Object} zone - Zone database record
 * @param {boolean} skipRecipe - Whether to skip recipe
 * @returns {Promise<{valid: boolean, error?: string, provisioning?: Object, recipeId?: string, zoneIP?: string, credentials?: Object}>}
 */
export const validateProvisioningRequest = async (zoneName, zone, skipRecipe) => {
  if (!validateZoneName(zoneName)) {
    return { valid: false, error: 'Invalid zone name' };
  }

  if (!zone) {
    return { valid: false, error: `Zone '${zoneName}' not found` };
  }

  let zoneConfig = zone.configuration;
  if (typeof zoneConfig === 'string') {
    try {
      zoneConfig = JSON.parse(zoneConfig);
    } catch (e) {
      log.api.warn('Failed to parse zone configuration', { error: e.message });
      zoneConfig = {};
    }
  }

  const config = zoneConfig?.provisioner;
  if (!config) {
    return {
      valid: false,
      error:
        'No provisioner configuration found. Set provisioner config via PUT /machines/:name first.',
    };
  }

  if (!zoneConfig.settings) {
    return {
      valid: false,
      error: 'Zone configuration has no settings section (Hosts.yml structure required)',
    };
  }

  const { extractCredentialsFromSettings, extractControlIP } =
    await import('../../../lib/ProvisionerConfigBuilder.js');

  const credentials = extractCredentialsFromSettings(zoneConfig.settings);
  if (!credentials.username) {
    return {
      valid: false,
      error: 'Credentials missing: settings.vagrant_user is required',
    };
  }

  const zoneIP = extractControlIP(zoneConfig.networks);
  if (!zoneIP) {
    return {
      valid: false,
      error: 'Zone IP address not found in networks array (set is_control: true on one network)',
    };
  }

  // Validate recipe if specified
  const recipeId = config.recipe_id;
  if (recipeId && !skipRecipe) {
    const recipe = await Recipes.findByPk(recipeId);
    if (!recipe) {
      return { valid: false, error: `Recipe '${recipeId}' not found` };
    }
  }

  return {
    valid: true,
    provisioning: config,
    recipeId,
    zoneIP,
    credentials,
  };
};
