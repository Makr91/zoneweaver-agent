/**
 * @fileoverview ZFS ARC Statistics Collection Module
 * @description Handles ZFS ARC (Adaptive Replacement Cache) statistics collection
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import ARCStats from '../../models/ARCStatsModel.js';
import { log } from '../../lib/Logger.js';
import { parseARCStatsOutput } from './utils/ParsingUtils.js';
import { executeKstatARC, safeExecuteCommand } from './utils/CommandUtils.js';

/**
 * ZFS ARC Statistics Collector Class
 * @description Handles collection of ZFS ARC performance metrics
 */
class ARCCollector {
  constructor(hostname, hostMonitoringConfig) {
    this.hostname = hostname;
    this.hostMonitoringConfig = hostMonitoringConfig;
  }

  /**
   * Collect ZFS ARC statistics
   * @description Gathers ARC cache performance metrics using kstat
   * @returns {Promise<Object|null>} ARC statistics object or null on failure
   */
  async collectARCStats() {
    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;

      // Get ARC stats using kstat (kstat doesn't need pfexec but let's be safe)
      const kstatOutput = await safeExecuteCommand(
        () => executeKstatARC(timeout),
        'ARC statistics collection',
        log.monitoring,
        this.hostname
      );

      if (!kstatOutput) {
        return null;
      }

      const arcStatsData = parseARCStatsOutput(kstatOutput, this.hostname);

      // Store ARC data in database
      await ARCStats.create(arcStatsData);

      return arcStatsData;
    } catch (error) {
      log.monitoring.error('Failed to collect ARC statistics', {
        error: error.message,
        hostname: this.hostname,
      });
      throw error;
    }
  }
}

export default ARCCollector;
