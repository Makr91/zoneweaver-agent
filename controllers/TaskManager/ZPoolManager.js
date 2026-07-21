import { parseAsync } from '../../lib/AsyncJson.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { buildVdevSpec, refreshStorageInventory } from './ZPoolHelpers.js';

export const executeCreatePoolTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { pool_name, vdevs, properties, force, mount_point } = metadata;

    let command = 'pfexec zpool create';

    if (force) {
      command += ' -f';
    }

    if (mount_point) {
      command += ` -m ${mount_point}`;
    }

    if (properties && Object.keys(properties).length > 0) {
      for (const [key, value] of Object.entries(properties)) {
        command += ` -o ${key}=${value}`;
      }
    }

    command += ` ${pool_name}`;
    command += ` ${buildVdevSpec(vdevs)}`;

    const result = await executeCommand(command);

    if (result.success) {
      void refreshStorageInventory();
      return {
        success: true,
        message: `Pool '${pool_name}' created successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to create pool '${pool_name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Pool creation task failed: ${error.message}` };
  }
};

export const executeDestroyPoolTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { pool_name, force } = metadata;

    let command = 'pfexec zpool destroy';

    if (force) {
      command += ' -f';
    }

    command += ` ${pool_name}`;

    const result = await executeCommand(command);

    if (result.success) {
      void refreshStorageInventory();
      return {
        success: true,
        message: `Pool '${pool_name}' destroyed successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to destroy pool '${pool_name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Pool destruction task failed: ${error.message}` };
  }
};

export const executeSetPoolPropertiesTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { pool_name, properties } = metadata;

    const results = await Promise.all(
      Object.entries(properties).map(async ([key, value]) => {
        const command = `pfexec zpool set ${key}=${value} ${pool_name}`;
        const result = await executeCommand(command);

        if (!result.success) {
          return { property: key, success: false, error: result.error };
        }
        return { property: key, success: true };
      })
    );

    const failed = results.filter(r => !r.success);

    if (failed.length === 0) {
      return {
        success: true,
        message: `Properties updated successfully for pool '${pool_name}'`,
      };
    }

    if (failed.length === results.length) {
      return {
        success: false,
        error: `Failed to update all properties for pool '${pool_name}'`,
      };
    }

    return {
      success: true,
      message: `Partially updated properties for pool '${pool_name}' (${failed.length} failed)`,
    };
  } catch (error) {
    return { success: false, error: `Pool property update task failed: ${error.message}` };
  }
};

export const executeExportPoolTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { pool_name, force } = metadata;

    let command = 'pfexec zpool export';

    if (force) {
      command += ' -f';
    }

    command += ` ${pool_name}`;

    const result = await executeCommand(command);

    if (result.success) {
      void refreshStorageInventory();
      return {
        success: true,
        message: `Pool '${pool_name}' exported successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to export pool '${pool_name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Export pool task failed: ${error.message}` };
  }
};

export const executeImportPoolTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { pool_name, pool_id, new_name, properties, force } = metadata;

    let command = 'pfexec zpool import';

    if (force) {
      command += ' -f';
    }

    if (properties && Object.keys(properties).length > 0) {
      for (const [key, value] of Object.entries(properties)) {
        command += ` -o ${key}=${value}`;
      }
    }

    if (pool_id) {
      command += ` ${pool_id}`;
    } else if (pool_name) {
      command += ` ${pool_name}`;
    }

    if (new_name) {
      command += ` ${new_name}`;
    }

    const result = await executeCommand(command);

    if (result.success) {
      void refreshStorageInventory();
      const displayName = new_name || pool_name || pool_id;
      return {
        success: true,
        message: `Pool '${displayName}' imported successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to import pool: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Import pool task failed: ${error.message}` };
  }
};

export const executeUpgradePoolTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { pool_name } = metadata;

    const command = `pfexec zpool upgrade ${pool_name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Pool '${pool_name}' upgraded successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to upgrade pool '${pool_name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Upgrade pool task failed: ${error.message}` };
  }
};
