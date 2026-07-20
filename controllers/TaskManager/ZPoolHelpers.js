import { log } from '../../lib/Logger.js';

/**
 * Pool-shape mutations invalidate the disk inventory's pool_assignment /
 * is_available the moment they land — kick an immediate storage collection
 * instead of leaving the UI stale until the next storage tick. Fire-and-forget
 * (a refresh failure never fails the task that already succeeded); dynamic
 * import keeps this module out of the monitoring service's import cycle.
 */
export const refreshStorageInventory = async () => {
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
export const buildVdevSpec = vdevs => {
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
