import yj from 'yieldable-json';
import config from '../../config/ConfigLoader.js';
import { executeCommand } from '../../lib/CommandManager.js';

/**
 * Package Manager for Package Operations
 * Handles package installation, uninstallation, updates, and metadata refresh
 */

const INSTALL_TIMEOUT_MS = (config.get('packages.install_timeout_seconds') || 600) * 1000;
const UPDATE_TIMEOUT_MS = (config.get('packages.update_timeout_seconds') || 1800) * 1000;

/**
 * Execute package installation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executePkgInstallTask = async metadataJson => {
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
    const { packages, accept_licenses, dry_run, be_name } = metadata;

    let command = `pfexec pkg install`;

    if (dry_run) {
      command += ` -n`;
    }

    if (accept_licenses) {
      command += ` --accept`;
    }

    if (be_name) {
      command += ` --be-name ${be_name}`;
    }

    // Add packages
    command += ` ${packages.join(' ')}`;

    const result = await executeCommand(command, INSTALL_TIMEOUT_MS);

    if (result.success) {
      return {
        success: true,
        message: `Successfully ${dry_run ? 'planned installation of' : 'installed'} ${packages.length} package(s): ${packages.join(', ')}`,
      };
    }
    return {
      success: false,
      error: `Failed to install packages: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Package installation task failed: ${error.message}` };
  }
};

/**
 * Execute package uninstallation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executePkgUninstallTask = async metadataJson => {
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
    const { packages, dry_run, be_name } = metadata;

    let command = `pfexec pkg uninstall`;

    if (dry_run) {
      command += ` -n`;
    }

    if (be_name) {
      command += ` --be-name ${be_name}`;
    }

    // Add packages
    command += ` ${packages.join(' ')}`;

    const result = await executeCommand(command, INSTALL_TIMEOUT_MS);

    if (result.success) {
      return {
        success: true,
        message: `Successfully ${dry_run ? 'planned uninstallation of' : 'uninstalled'} ${packages.length} package(s): ${packages.join(', ')}`,
      };
    }
    return {
      success: false,
      error: `Failed to uninstall packages: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Package uninstallation task failed: ${error.message}` };
  }
};

/**
 * Execute system update task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executePkgUpdateTask = async metadataJson => {
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
    const { packages, accept_licenses, be_name, backup_be, reject_packages } = metadata;

    let command = `pfexec pkg update`;

    if (accept_licenses) {
      command += ` --accept`;
    }

    if (be_name) {
      command += ` --be-name ${be_name}`;
    }

    if (backup_be === false) {
      command += ` --no-backup-be`;
    }

    // Add reject packages
    if (reject_packages && reject_packages.length > 0) {
      for (const pkg of reject_packages) {
        command += ` --reject ${pkg}`;
      }
    }

    // Add specific packages if provided, otherwise update all
    if (packages && packages.length > 0) {
      command += ` ${packages.join(' ')}`;
    }

    const result = await executeCommand(command, UPDATE_TIMEOUT_MS);

    if (result.success) {
      return {
        success: true,
        message:
          packages && packages.length > 0
            ? `Successfully updated ${packages.length} specific package(s): ${packages.join(', ')}`
            : 'Successfully updated all available packages',
      };
    }
    return {
      success: false,
      error: `Failed to update packages: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Package update task failed: ${error.message}` };
  }
};

/**
 * Execute package metadata refresh task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executePkgRefreshTask = async metadataJson => {
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
    const { full, publishers } = metadata;

    let command = `pfexec pkg refresh`;

    if (full) {
      command += ` --full`;
    }

    // Add specific publishers if provided
    if (publishers && publishers.length > 0) {
      command += ` ${publishers.join(' ')}`;
    }

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message:
          publishers && publishers.length > 0
            ? `Successfully refreshed metadata for ${publishers.length} publisher(s): ${publishers.join(', ')}`
            : 'Successfully refreshed metadata for all publishers',
      };
    }
    return {
      success: false,
      error: `Failed to refresh metadata: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Package refresh task failed: ${error.message}` };
  }
};
