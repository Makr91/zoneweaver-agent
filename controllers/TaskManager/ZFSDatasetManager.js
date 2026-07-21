import { parseAsync } from '../../lib/AsyncJson.js';
import { executeCommand } from '../../lib/CommandManager.js';

export const executeCreateDatasetTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name, type, properties } = metadata;

    let command = `pfexec zfs create`;

    if (properties && Object.keys(properties).length > 0) {
      for (const [key, value] of Object.entries(properties)) {
        command += ` -o ${key}=${value}`;
      }
    }

    if (type === 'volume') {
      if (!properties.volsize) {
        return { success: false, error: 'volsize is required for volumes' };
      }
      command += ` -V ${properties.volsize}`;
    }

    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Dataset '${name}' created successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to create dataset '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Dataset creation task failed: ${error.message}` };
  }
};

export const executeDestroyDatasetTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name, recursive, force } = metadata;

    let command = `pfexec zfs destroy`;

    if (recursive) {
      command += ` -r`;
    }

    if (force) {
      command += ` -f`;
    }

    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Dataset '${name}' destroyed successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to destroy dataset '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Dataset destruction task failed: ${error.message}` };
  }
};

export const executeSetPropertiesTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name, properties } = metadata;

    const results = await Promise.all(
      Object.entries(properties).map(async ([key, value]) => {
        const command = `pfexec zfs set ${key}=${value} ${name}`;
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
        message: `Properties updated successfully for '${name}'`,
      };
    }

    if (failed.length === results.length) {
      return {
        success: false,
        error: `Failed to update all properties for '${name}'`,
      };
    }

    return {
      success: true,
      message: `Partially updated properties for '${name}' (${failed.length} failed)`,
    };
  } catch (error) {
    return { success: false, error: `Property update task failed: ${error.message}` };
  }
};

export const executeCloneDatasetTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { snapshot, target, properties } = metadata;

    let command = `pfexec zfs clone`;

    if (properties && Object.keys(properties).length > 0) {
      for (const [key, value] of Object.entries(properties)) {
        command += ` -o ${key}=${value}`;
      }
    }

    command += ` ${snapshot} ${target}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Clone '${target}' created from '${snapshot}' successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to clone '${snapshot}' to '${target}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Clone task failed: ${error.message}` };
  }
};

export const executePromoteDatasetTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name } = metadata;

    const command = `pfexec zfs promote ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Dataset '${name}' promoted successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to promote dataset '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Promote task failed: ${error.message}` };
  }
};

export const executeRenameDatasetTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name, new_name, recursive, force } = metadata;

    let command = `pfexec zfs rename`;

    if (force) {
      command += ` -f`;
    }

    if (recursive) {
      command += ` -r`;
    }

    command += ` ${name} ${new_name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Dataset renamed from '${name}' to '${new_name}' successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to rename dataset '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Rename task failed: ${error.message}` };
  }
};

export const executeCreateSnapshotTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { name, recursive, properties } = metadata;

    let command = `pfexec zfs snapshot`;

    if (recursive) {
      command += ` -r`;
    }

    if (properties && Object.keys(properties).length > 0) {
      for (const [key, value] of Object.entries(properties)) {
        command += ` -o ${key}=${value}`;
      }
    }

    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Snapshot '${name}' created successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to create snapshot '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Snapshot creation task failed: ${error.message}` };
  }
};

export const executeDestroySnapshotTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { snapshot, recursive, defer } = metadata;

    let command = `pfexec zfs destroy`;

    if (defer) {
      command += ` -d`;
    }

    if (recursive) {
      command += ` -r`;
    }

    command += ` ${snapshot}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Snapshot '${snapshot}' destroyed successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to destroy snapshot '${snapshot}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Snapshot destruction task failed: ${error.message}` };
  }
};

export const executeRollbackSnapshotTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { snapshot, recursive, force } = metadata;

    let command = `pfexec zfs rollback`;

    if (recursive) {
      command += ` -r`;
    }

    if (force) {
      command += ` -f`;
    }

    command += ` ${snapshot}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Rolled back to snapshot '${snapshot}' successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to rollback to snapshot '${snapshot}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Rollback task failed: ${error.message}` };
  }
};

export const executeHoldSnapshotTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { snapshot, tag, recursive } = metadata;

    let command = `pfexec zfs hold`;

    if (recursive) {
      command += ` -r`;
    }

    command += ` ${tag} ${snapshot}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Hold '${tag}' applied to snapshot '${snapshot}' successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to hold snapshot '${snapshot}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Hold task failed: ${error.message}` };
  }
};

export const executeReleaseSnapshotTask = async metadataJson => {
  try {
    const metadata = await parseAsync(metadataJson);
    const { snapshot, tag, recursive } = metadata;

    let command = `pfexec zfs release`;

    if (recursive) {
      command += ` -r`;
    }

    command += ` ${tag} ${snapshot}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Hold '${tag}' released from snapshot '${snapshot}' successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to release hold from snapshot '${snapshot}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Release task failed: ${error.message}` };
  }
};
