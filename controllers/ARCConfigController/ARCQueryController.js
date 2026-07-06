import os from 'os';
import { getRebootStatus } from '../../lib/RebootManager.js';
import { log } from '../../lib/Logger.js';
import {
  getCurrentARCStats,
  getPhysicalMemoryBytes,
  getZFSTunableParams,
  getPersistentConfigInfo,
} from './utils/ARCStatsHelper.js';

/**
 * @fileoverview ZFS ARC configuration query controller
 */

/**
 * @swagger
 * /system/zfs/arc/config:
 *   get:
 *     summary: Get ZFS ARC configuration
 *     description: Returns current ZFS ARC settings, available tunables, and system constraints
 *     tags: [ZFS ARC Management]
 *     responses:
 *       200:
 *         description: ZFS ARC configuration data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 host:
 *                   type: string
 *                 current_config:
 *                   type: object
 *                   properties:
 *                     arc_size_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Current ARC size in bytes
 *                     arc_max_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Current ARC maximum size in bytes
 *                     arc_min_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Current ARC minimum size in bytes
 *                     arc_meta_used_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Current ARC metadata usage in bytes
 *                     arc_meta_limit_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Current ARC metadata limit in bytes
 *                     arc_meta_min_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Current ARC minimum metadata size in bytes
 *                 system_constraints:
 *                   type: object
 *                   properties:
 *                     physical_memory_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Total physical memory in bytes
 *                     max_safe_arc_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Maximum safe ARC size (85% of physical memory)
 *                     min_recommended_arc_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Minimum recommended ARC size
 *                 available_tunables:
 *                   type: object
 *                   description: Available ZFS ARC tunable parameters
 *                 config_source:
 *                   type: string
 *                   description: Source of current configuration
 *                 reboot_required:
 *                   type: boolean
 *                   description: Whether a reboot is required for persistent changes
 *                 config_file_path:
 *                   type: string
 *                   nullable: true
 *                   description: Path to the persistent ARC config file (if any)
 *                 last_collected:
 *                   type: string
 *                   format: date-time
 *                   description: scan_timestamp of the ARC stats sample
 *       500:
 *         description: Failed to get ZFS ARC configuration
 */
export const getARCConfig = async (req, res) => {
  void req;
  const hostname = os.hostname();
  try {
    // Get current ARC statistics
    const arcStats = await getCurrentARCStats();

    // Get system memory information
    const physicalMemoryBytes = await getPhysicalMemoryBytes();

    // Get ZFS tunable parameters
    const tunableParams = await getZFSTunableParams();

    // Check for persistent configuration
    const configInfo = await getPersistentConfigInfo();

    // Get actual reboot status from RebootManager
    const rebootStatus = await getRebootStatus();

    // Calculate system constraints
    const maxSafeARCBytes = Math.floor(physicalMemoryBytes * 0.85);
    const minRecommendedARCBytes = Math.floor(physicalMemoryBytes * 0.01);

    // Build available tunables info
    const availableTunables = {
      zfs_arc_max: {
        current_value: tunableParams.zfs_arc_max || 0,
        effective_value: arcStats.arc_max_bytes,
        min_safe: minRecommendedARCBytes,
        max_safe: maxSafeARCBytes,
        description: 'Maximum ARC size in bytes (0 = auto-calculated)',
        dynamic: false,
        requires_reboot: true,
      },
      zfs_arc_min: {
        current_value: tunableParams.zfs_arc_min || 0,
        effective_value: arcStats.arc_min_bytes,
        min_safe: 134217728, // 128MB
        max_safe: Math.floor(physicalMemoryBytes * 0.1), // 10% of system memory
        description: 'Minimum ARC size in bytes (0 = auto-calculated)',
        dynamic: false,
        requires_reboot: true,
      },
      zfs_arc_max_percent: {
        current_value: tunableParams.zfs_arc_max_percent || 90,
        effective_value: Math.round((arcStats.arc_max_bytes / physicalMemoryBytes) * 100),
        min_safe: 1,
        max_safe: 100,
        description: 'Maximum ARC size as percentage of physical memory',
        dynamic: true,
        requires_reboot: false,
      },
      zfs_vdev_max_pending: {
        current_value: tunableParams.zfs_vdev_max_pending || 10,
        effective_value: tunableParams.zfs_vdev_max_pending || 10,
        min_safe: 1,
        max_safe: 100,
        description: 'Maximum number of concurrent I/Os pending to each device',
        dynamic: true,
        requires_reboot: false,
      },
      user_reserve_hint_pct: {
        current_value: tunableParams.user_reserve_hint_pct || 0,
        effective_value: tunableParams.user_reserve_hint_pct || 0,
        min_safe: 0,
        max_safe: 99,
        description:
          'Percentage of memory reserved for application use (alternative to zfs_arc_max)',
        dynamic: true,
        requires_reboot: false,
      },
      zfs_prefetch_disable: {
        current_value: tunableParams.zfs_prefetch_disable || 0,
        effective_value: tunableParams.zfs_prefetch_disable || 0,
        min_safe: 0,
        max_safe: 1,
        description: 'Disable ZFS file-level prefetching (0=enabled, 1=disabled)',
        dynamic: true,
        requires_reboot: false,
      },
      zfs_arc_meta_limit: {
        current_value: tunableParams.zfs_arc_meta_limit || 0,
        effective_value: arcStats.arc_meta_limit_bytes,
        min_safe: 67108864, // 64MB
        max_safe: Math.floor(physicalMemoryBytes * 0.25), // 25% of system memory
        description: 'ARC metadata limit in bytes (0 = auto-calculated)',
        dynamic: false,
        requires_reboot: true,
      },
      zfs_arc_meta_min: {
        current_value: tunableParams.zfs_arc_meta_min || 0,
        effective_value: arcStats.arc_meta_min_bytes,
        min_safe: 16777216, // 16MB
        max_safe: Math.floor(physicalMemoryBytes * 0.05), // 5% of system memory
        description: 'Minimum ARC metadata size in bytes (0 = auto-calculated)',
        dynamic: false,
        requires_reboot: true,
      },
    };

    res.json({
      host: hostname,
      current_config: {
        arc_size_bytes: arcStats.arc_size_bytes,
        arc_max_bytes: arcStats.arc_max_bytes,
        arc_min_bytes: arcStats.arc_min_bytes,
        arc_meta_used_bytes: arcStats.arc_meta_used_bytes,
        arc_meta_limit_bytes: arcStats.arc_meta_limit_bytes,
        arc_meta_min_bytes: arcStats.arc_meta_min_bytes,
      },
      system_constraints: {
        physical_memory_bytes: physicalMemoryBytes,
        max_safe_arc_bytes: maxSafeARCBytes,
        min_recommended_arc_bytes: minRecommendedARCBytes,
      },
      available_tunables: availableTunables,
      config_source: configInfo.source,
      config_file_path: configInfo.filePath,
      reboot_required: rebootStatus.required,
      last_collected: arcStats.scan_timestamp,
    });
  } catch (error) {
    log.api.error('Error getting ZFS ARC configuration', {
      error: error.message,
      stack: error.stack,
      host: hostname,
    });
    res.status(500).json({
      error: 'Failed to get ZFS ARC configuration',
      details: error.message,
    });
  }
};
