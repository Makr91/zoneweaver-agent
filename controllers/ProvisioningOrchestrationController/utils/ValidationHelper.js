/**
 * @fileoverview Provisioning request validation helper
 */

import Recipes from '../../../models/RecipeModel.js';
import { validateZoneName } from '../../../lib/ZoneValidation.js';
import { parseConfiguration } from '../../../lib/ZoneConfigUtils.js';

/**
 * Validate provisioning request and zone state (Hosts.yml structure:
 * provisioner + settings/networks)
 * @param {string} zoneName - Zone name
 * @param {Object} zone - Zone database record
 * @param {boolean} skipRecipe - Whether to skip recipe
 * @returns {Promise<{valid: boolean, error?: string, provisioning?: Object, zoneConfig?: Object, recipeId?: string, zoneIP?: string, credentials?: Object}>}
 */
export const validateProvisioningRequest = async (zoneName, zone, skipRecipe) => {
  if (!validateZoneName(zoneName)) {
    return { valid: false, error: 'Invalid zone name' };
  }

  if (!zone) {
    return { valid: false, error: `Zone '${zoneName}' not found` };
  }

  const zoneConfig = parseConfiguration(zone);

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

  // settings.vagrant_user is optional — extractCredentialsFromSettings
  // defaults the username to root (Hosts.rb's own default).
  const credentials = extractCredentialsFromSettings(zoneConfig.settings);

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
    zoneConfig,
    recipeId,
    zoneIP,
    credentials,
  };
};
