import yj from 'yieldable-json';
import { executeCommand } from '../../lib/CommandManager.js';
import { buildVdevSpec, refreshStorageInventory } from './ZPoolHelpers.js';

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
