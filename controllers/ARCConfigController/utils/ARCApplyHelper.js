import { exec } from 'child_process';
import util from 'util';
import { log } from '../../../lib/Logger.js';
import { formatBytes } from './ARCStatsHelper.js';

const execProm = util.promisify(exec);

/**
 * @fileoverview ARC configuration application utilities
 */

/**
 * Helper function to categorize ZFS parameters into dynamic and non-dynamic
 * @param {Object} params - ZFS parameters
 * @returns {Object} Categorized parameters
 */
export const categorizeZFSParameters = params => {
  const {
    arcMaxBytes,
    arcMinBytes,
    arc_max_percent,
    vdev_max_pending,
    user_reserve_hint_pct,
    prefetch_disable,
  } = params;

  const nonDynamicParams = [];
  const dynamicParams = [];

  if (arcMaxBytes || arcMinBytes) {
    nonDynamicParams.push('zfs_arc_max/zfs_arc_min');
  }
  if (arc_max_percent !== undefined) {
    dynamicParams.push('zfs_arc_max_percent');
  }
  if (vdev_max_pending !== undefined) {
    dynamicParams.push('zfs_vdev_max_pending');
  }
  if (user_reserve_hint_pct !== undefined) {
    dynamicParams.push('user_reserve_hint_pct');
  }
  if (prefetch_disable !== undefined) {
    dynamicParams.push('zfs_prefetch_disable');
  }

  return { nonDynamicParams, dynamicParams };
};

/**
 * Helper function to add parameter warnings
 * @param {Object} results - Results object to add warnings to
 * @param {string} applyMethod - Apply method (runtime/persistent/both)
 * @param {Array} nonDynamicParams - List of non-dynamic parameters
 * @param {Array} dynamicParams - List of dynamic parameters
 */
export const addParameterWarnings = (results, applyMethod, nonDynamicParams, dynamicParams) => {
  if (applyMethod === 'runtime' || applyMethod === 'both') {
    if (nonDynamicParams.length > 0) {
      results.warnings.push(
        `WARNING: ${nonDynamicParams.join(', ')} are NOT dynamic parameters and require system reboot to take effect.`
      );
    }
    if (dynamicParams.length > 0) {
      results.warnings.push(
        `INFO: ${dynamicParams.join(', ')} are dynamic parameters and will take effect immediately.`
      );
    }
  }
};

/**
 * Helper function to apply runtime ZFS setting
 * @param {string} parameter - Parameter name (e.g., 'zfs_arc_max', 'zfs_vdev_max_pending')
 * @param {number} value - Value to set
 */
const applyRuntimeZFSSetting = async (parameter, value) => {
  try {
    const command = `echo "${parameter}/W0t${value}" | pfexec mdb -kw`;
    log.app.info('Applying runtime ZFS setting', {
      parameter,
      value,
    });

    await execProm(command, { timeout: 10000 });
  } catch (error) {
    throw new Error(`Failed to apply runtime ZFS setting ${parameter}: ${error.message}`);
  }
};

/**
 * Helper function to apply runtime ZFS configuration
 * @param {Object} params - ZFS parameters
 * @param {Object} results - Results object to update
 */
export const applyRuntimeZFSConfiguration = async (params, results) => {
  const {
    arcMaxBytes,
    arcMinBytes,
    arc_max_percent,
    vdev_max_pending,
    user_reserve_hint_pct,
    prefetch_disable,
  } = params;

  if (arcMaxBytes) {
    await applyRuntimeZFSSetting('zfs_arc_max', arcMaxBytes);
    results.changes.push(`Runtime: Set ARC max to ${formatBytes(arcMaxBytes)} (requires reboot)`);
  }
  if (arcMinBytes) {
    await applyRuntimeZFSSetting('zfs_arc_min', arcMinBytes);
    results.changes.push(`Runtime: Set ARC min to ${formatBytes(arcMinBytes)} (requires reboot)`);
  }
  if (arc_max_percent !== undefined) {
    await applyRuntimeZFSSetting('zfs_arc_max_percent', arc_max_percent);
    results.changes.push(`Runtime: Set ARC max percent to ${arc_max_percent}%`);
  }
  if (vdev_max_pending !== undefined) {
    await applyRuntimeZFSSetting('zfs_vdev_max_pending', vdev_max_pending);
    results.changes.push(`Runtime: Set vdev max pending to ${vdev_max_pending}`);
  }
  if (user_reserve_hint_pct !== undefined) {
    await applyRuntimeZFSSetting('user_reserve_hint_pct', user_reserve_hint_pct);
    results.changes.push(`Runtime: Set user reserve hint to ${user_reserve_hint_pct}%`);
  }
  if (prefetch_disable !== undefined) {
    const prefetchValue = prefetch_disable ? 1 : 0;
    await applyRuntimeZFSSetting('zfs_prefetch_disable', prefetchValue);
    results.changes.push(`Runtime: ${prefetch_disable ? 'Disabled' : 'Enabled'} ZFS prefetching`);
  }

  results.runtime_applied = true;
};

/**
 * Helper function to apply persistent ZFS configuration messages
 * @param {Object} params - ZFS parameters
 * @param {Object} results - Results object to update
 */
export const addPersistentConfigurationMessages = (params, results) => {
  const {
    arcMaxBytes,
    arcMinBytes,
    arc_max_percent,
    vdev_max_pending,
    user_reserve_hint_pct,
    prefetch_disable,
  } = params;

  if (arcMaxBytes) {
    results.changes.push(`Persistent: Set ARC max to ${formatBytes(arcMaxBytes)}`);
  }
  if (arcMinBytes) {
    results.changes.push(`Persistent: Set ARC min to ${formatBytes(arcMinBytes)}`);
  }
  if (arc_max_percent !== undefined) {
    results.changes.push(`Persistent: Set ARC max percent to ${arc_max_percent}%`);
  }
  if (vdev_max_pending !== undefined) {
    results.changes.push(`Persistent: Set vdev max pending to ${vdev_max_pending}`);
  }
  if (user_reserve_hint_pct !== undefined) {
    results.changes.push(`Persistent: Set user reserve hint to ${user_reserve_hint_pct}%`);
  }
  if (prefetch_disable !== undefined) {
    results.changes.push(
      `Persistent: ${prefetch_disable ? 'Disabled' : 'Enabled'} ZFS prefetching`
    );
  }
};

/**
 * Helper function to apply persistent ZFS settings
 * @param {Object} settings - Settings to apply
 */
export const applyPersistentZFSSettings = async settings => {
  const configPath = '/etc/system.d/zfs-arc.conf';

  try {
    let configContent = `# ZFS Configuration - Generated by Zoneweaver Agent\n`;
    configContent += `# Created: ${new Date().toISOString()}\n`;
    configContent += `# WARNING: This file is managed by the Zoneweaver Agent\n\n`;

    // ARC memory settings (non-dynamic)
    if (settings.arc_max_bytes) {
      configContent += `set zfs:zfs_arc_max = ${settings.arc_max_bytes}\n`;
    }

    if (settings.arc_min_bytes) {
      configContent += `set zfs:zfs_arc_min = ${settings.arc_min_bytes}\n`;
    }

    // Dynamic parameters (can be set persistently for boot-time defaults)
    if (settings.arc_max_percent !== undefined) {
      configContent += `set zfs:zfs_arc_max_percent = ${settings.arc_max_percent}\n`;
    }

    if (settings.vdev_max_pending !== undefined) {
      configContent += `set zfs:zfs_vdev_max_pending = ${settings.vdev_max_pending}\n`;
    }

    if (settings.user_reserve_hint_pct !== undefined) {
      configContent += `set zfs:user_reserve_hint_pct = ${settings.user_reserve_hint_pct}\n`;
    }

    if (settings.prefetch_disable !== undefined) {
      const prefetchValue = settings.prefetch_disable ? 1 : 0;
      configContent += `set zfs:zfs_prefetch_disable = ${prefetchValue}\n`;
    }

    // Use pfexec to write the file with proper permissions
    const command = `echo '${configContent.replace(/'/g, "'\\''")}' | pfexec tee ${configPath}`;
    await execProm(command, { timeout: 10000 });

    log.app.info('Successfully created persistent ZFS configuration', {
      config_path: configPath,
    });
  } catch (error) {
    throw new Error(`Failed to create persistent ZFS configuration: ${error.message}`);
  }
};

/**
 * Helper function to trigger immediate ARC stats collection
 */
export const triggerARCStatsCollection = async () => {
  try {
    const StorageCollector = (await import('../../StorageCollector.js')).default;
    const collector = new StorageCollector();
    await collector.collectARCStats();
  } catch (collectionError) {
    log.monitoring.warn('Failed to immediately update ARC stats data', {
      error: collectionError.message,
    });
  }
};
