import { parseAsync } from '../../lib/AsyncJson.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';

/**
 * Repository Manager for Package Repository Operations
 * Handles repository addition, removal, modification, enable, and disable operations
 */

/**
 * Helper function to build repository command options
 * @param {Object} metadata - Repository metadata
 * @returns {string} Command options string
 */
const buildRepositoryOptions = metadata => {
  const {
    ssl_cert,
    ssl_key,
    mirrors,
    search_first,
    search_before,
    search_after,
    sticky,
    properties,
    proxy,
  } = metadata;

  let options = '';

  // Add SSL credentials
  if (ssl_cert) {
    options += ` -c ${ssl_cert}`;
  }
  if (ssl_key) {
    options += ` -k ${ssl_key}`;
  }

  // Add mirrors
  if (mirrors && mirrors.length > 0) {
    for (const mirror of mirrors) {
      options += ` -m ${mirror}`;
    }
  }

  // Add search order options
  if (search_first) {
    options += ` --search-first`;
  } else if (search_before) {
    options += ` --search-before ${search_before}`;
  } else if (search_after) {
    options += ` --search-after ${search_after}`;
  }

  // Add sticky/non-sticky
  if (sticky === false) {
    options += ` --non-sticky`;
  }

  // Add properties
  if (properties && Object.keys(properties).length > 0) {
    for (const [key, value] of Object.entries(properties)) {
      options += ` --set-property ${key}=${value}`;
    }
  }

  // Add proxy
  if (proxy) {
    options += ` --proxy ${proxy}`;
  }

  return options;
};

/**
 * Execute repository addition task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRepositoryAddTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name, origin, enabled } = metadata;

    // Build command using helper function
    const command = `pfexec pkg set-publisher -g ${origin}${buildRepositoryOptions(metadata)} ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      // If enabled is false, disable the publisher
      if (enabled === false) {
        const disableResult = await executeCommand(`pfexec pkg set-publisher --disable ${name}`);
        if (!disableResult.success) {
          log.task.warn('Publisher added but failed to disable', {
            name,
            error: disableResult.error,
          });
        }
      }

      return {
        success: true,
        message: `Repository '${name}' added successfully${enabled === false ? ' (disabled)' : ''}`,
      };
    }
    return {
      success: false,
      error: `Failed to add repository '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Repository addition task failed: ${error.message}` };
  }
};

/**
 * Execute repository removal task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRepositoryRemoveTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name } = metadata;

    const command = `pfexec pkg unset-publisher ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Repository '${name}' removed successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to remove repository '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Repository removal task failed: ${error.message}` };
  }
};

/**
 * Helper function to build SSL options
 * @param {Object} metadata - Repository metadata
 * @returns {string} SSL options string
 */
const buildSSLOptions = metadata => {
  const { ssl_cert, ssl_key } = metadata;
  let options = '';

  if (ssl_cert) {
    options += ` -c ${ssl_cert}`;
  }
  if (ssl_key) {
    options += ` -k ${ssl_key}`;
  }

  return options;
};

/**
 * Helper function to build repository endpoint options
 * @param {Object} metadata - Repository metadata
 * @returns {string} Endpoint options string
 */
const buildEndpointOptions = metadata => {
  const { origins_to_add, origins_to_remove, mirrors_to_add, mirrors_to_remove } = metadata;
  let options = '';

  // Add origins
  if (origins_to_add && origins_to_add.length > 0) {
    for (const origin of origins_to_add) {
      options += ` -g ${origin}`;
    }
  }
  if (origins_to_remove && origins_to_remove.length > 0) {
    for (const origin of origins_to_remove) {
      options += ` -G ${origin}`;
    }
  }

  // Add mirrors
  if (mirrors_to_add && mirrors_to_add.length > 0) {
    for (const mirror of mirrors_to_add) {
      options += ` -m ${mirror}`;
    }
  }
  if (mirrors_to_remove && mirrors_to_remove.length > 0) {
    for (const mirror of mirrors_to_remove) {
      options += ` -M ${mirror}`;
    }
  }

  return options;
};

/**
 * Helper function to build repository behavior options
 * @param {Object} metadata - Repository metadata
 * @returns {string} Behavior options string
 */
const buildBehaviorOptions = metadata => {
  const { enabled, sticky, search_first, search_before, search_after } = metadata;
  let options = '';

  // Add enable/disable
  if (enabled === true) {
    options += ` --enable`;
  } else if (enabled === false) {
    options += ` --disable`;
  }

  // Add sticky/non-sticky
  if (sticky === true) {
    options += ` --sticky`;
  } else if (sticky === false) {
    options += ` --non-sticky`;
  }

  // Add search order options
  if (search_first) {
    options += ` --search-first`;
  } else if (search_before) {
    options += ` --search-before ${search_before}`;
  } else if (search_after) {
    options += ` --search-after ${search_after}`;
  }

  return options;
};

/**
 * Helper function to build properties options
 * @param {Object} metadata - Repository metadata
 * @returns {string} Properties options string
 */
const buildPropertiesOptions = metadata => {
  const { properties_to_set, properties_to_unset } = metadata;
  let options = '';

  // Add properties to set
  if (properties_to_set && Object.keys(properties_to_set).length > 0) {
    for (const [key, value] of Object.entries(properties_to_set)) {
      options += ` --set-property ${key}=${value}`;
    }
  }

  // Add properties to unset
  if (properties_to_unset && properties_to_unset.length > 0) {
    for (const prop of properties_to_unset) {
      options += ` --unset-property ${prop}`;
    }
  }

  return options;
};

/**
 * Helper function to build miscellaneous options
 * @param {Object} metadata - Repository metadata
 * @returns {string} Miscellaneous options string
 */
const buildMiscOptions = metadata => {
  const { proxy, reset_uuid, refresh } = metadata;
  let options = '';

  // Add proxy
  if (proxy) {
    options += ` --proxy ${proxy}`;
  }

  // Add reset UUID
  if (reset_uuid) {
    options += ` --reset-uuid`;
  }

  // Add refresh
  if (refresh) {
    options += ` --refresh`;
  }

  return options;
};

/**
 * Helper function to build repository modification options
 * @param {Object} metadata - Repository metadata
 * @returns {string} Command options string
 */
const buildModificationOptions = metadata =>
  buildSSLOptions(metadata) +
  buildEndpointOptions(metadata) +
  buildBehaviorOptions(metadata) +
  buildPropertiesOptions(metadata) +
  buildMiscOptions(metadata);

/**
 * Execute repository modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRepositoryModifyTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name } = metadata;

    const command = `pfexec pkg set-publisher${buildModificationOptions(metadata)} ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Repository '${name}' modified successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to modify repository '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Repository modification task failed: ${error.message}` };
  }
};

/**
 * Execute repository enable task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRepositoryEnableTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name } = metadata;

    const command = `pfexec pkg set-publisher --enable ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Repository '${name}' enabled successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to enable repository '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Repository enable task failed: ${error.message}` };
  }
};

/**
 * Execute repository disable task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRepositoryDisableTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name } = metadata;

    const command = `pfexec pkg set-publisher --disable ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Repository '${name}' disabled successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to disable repository '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Repository disable task failed: ${error.message}` };
  }
};
