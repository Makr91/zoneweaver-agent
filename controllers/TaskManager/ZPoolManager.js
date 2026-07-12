import yj from 'yieldable-json';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';

/**
 * Pool-shape mutations invalidate the disk inventory's pool_assignment /
 * is_available the moment they land — kick an immediate storage collection
 * instead of leaving the UI stale until the next storage tick. Fire-and-forget
 * (a refresh failure never fails the task that already succeeded); dynamic
 * import keeps this module out of the monitoring service's import cycle.
 */
const refreshStorageInventory = async () => {
  try {
    const { getHostMonitoringService } = await import('../HostMonitoringService.js');
    await getHostMonitoringService().triggerCollection('storage');
  } catch (error) {
    log.monitoring.warn('Post-mutation storage inventory refresh failed', {
      error: error.message,
    });
  }
};

/**
 * Build a vdev specification string from an array of vdev objects
 * Each vdev object: { type?: 'mirror'|'raidz'|'raidz2'|'raidz3'|'spare'|'log'|'cache'|'special', devices: string[] }
 * Or a simple string device path for single-disk vdevs
 * @param {Array} vdevs - Array of vdev specifications
 * @returns {string} Space-separated vdev specification
 */
const buildVdevSpec = vdevs => {
  const parts = [];
  for (const vdev of vdevs) {
    if (typeof vdev === 'string') {
      parts.push(vdev);
    } else if (vdev && typeof vdev === 'object') {
      if (vdev.type) {
        parts.push(vdev.type);
      }
      if (Array.isArray(vdev.devices)) {
        parts.push(...vdev.devices);
      }
    }
  }
  return parts.join(' ');
};

export const executeCreatePoolTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
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
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
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
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
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

export const executeAddVdevTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { pool_name, vdevs, force } = metadata;

    let command = 'pfexec zpool add';

    if (force) {
      command += ' -f';
    }

    command += ` ${pool_name}`;
    command += ` ${buildVdevSpec(vdevs)}`;

    const result = await executeCommand(command);

    if (result.success) {
      void refreshStorageInventory();
      return {
        success: true,
        message: `Vdev added to pool '${pool_name}' successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to add vdev to pool '${pool_name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Add vdev task failed: ${error.message}` };
  }
};

export const executeRemoveVdevTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { pool_name, device } = metadata;

    const command = `pfexec zpool remove ${pool_name} ${device}`;

    const result = await executeCommand(command);

    if (result.success) {
      void refreshStorageInventory();
      return {
        success: true,
        message: `Device '${device}' removal initiated from pool '${pool_name}'`,
      };
    }
    return {
      success: false,
      error: `Failed to remove device '${device}' from pool '${pool_name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Remove vdev task failed: ${error.message}` };
  }
};

export const executeReplaceDeviceTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { pool_name, old_device, new_device, force } = metadata;

    let command = 'pfexec zpool replace';

    if (force) {
      command += ' -f';
    }

    command += ` ${pool_name} ${old_device} ${new_device}`;

    const result = await executeCommand(command);

    if (result.success) {
      void refreshStorageInventory();
      return {
        success: true,
        message: `Device '${old_device}' replaced with '${new_device}' in pool '${pool_name}'`,
      };
    }
    return {
      success: false,
      error: `Failed to replace device in pool '${pool_name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Replace device task failed: ${error.message}` };
  }
};

export const executeOnlineDeviceTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { pool_name, device, expand } = metadata;

    let command = 'pfexec zpool online';

    if (expand) {
      command += ' -e';
    }

    command += ` ${pool_name} ${device}`;

    const result = await executeCommand(command);

    if (result.success) {
      void refreshStorageInventory();
      return {
        success: true,
        message: `Device '${device}' brought online in pool '${pool_name}'`,
      };
    }
    return {
      success: false,
      error: `Failed to online device '${device}' in pool '${pool_name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Online device task failed: ${error.message}` };
  }
};

export const executeOfflineDeviceTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { pool_name, device, temporary } = metadata;

    let command = 'pfexec zpool offline';

    if (temporary) {
      command += ' -t';
    }

    command += ` ${pool_name} ${device}`;

    const result = await executeCommand(command);

    if (result.success) {
      void refreshStorageInventory();
      return {
        success: true,
        message: `Device '${device}' taken offline in pool '${pool_name}'`,
      };
    }
    return {
      success: false,
      error: `Failed to offline device '${device}' in pool '${pool_name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Offline device task failed: ${error.message}` };
  }
};

export const executeScrubPoolTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { pool_name } = metadata;

    const command = `pfexec zpool scrub ${pool_name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Scrub started on pool '${pool_name}'`,
      };
    }
    return {
      success: false,
      error: `Failed to start scrub on pool '${pool_name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Scrub task failed: ${error.message}` };
  }
};

export const executeStopScrubTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { pool_name } = metadata;

    const command = `pfexec zpool scrub -s ${pool_name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Scrub stopped on pool '${pool_name}'`,
      };
    }
    return {
      success: false,
      error: `Failed to stop scrub on pool '${pool_name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Stop scrub task failed: ${error.message}` };
  }
};

export const executeExportPoolTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
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
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
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
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
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
