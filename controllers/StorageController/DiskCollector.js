/**
 * @fileoverview Disk Data Collection Module
 * @description Handles physical disk information collection and processing
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import Disks from '../../models/DiskModel.js';
import { log } from '../../lib/Logger.js';
import { parseDiskinfoInventory, applyFormatEnrichment } from './utils/ParsingUtils.js';
import {
  executeFormatList,
  executeZpoolStatus,
  executeDiskinfo,
  safeExecuteCommand,
} from './utils/CommandUtils.js';
import { BatchProcessor, assignDisksToePools } from './utils/HostUtils.js';

/**
 * Disk Data Collector Class
 * @description Handles collection of physical disk information
 */
class DiskCollector {
  constructor(hostname, hostMonitoringConfig) {
    this.hostname = hostname;
    this.hostMonitoringConfig = hostMonitoringConfig;
    this.batchProcessor = new BatchProcessor(hostMonitoringConfig.performance.batch_size);
  }

  /**
   * Collect disk inventory information
   * @description diskinfo is the PRIMARY source (one machine-friendly table,
   * clean exit code); format only enriches (firmware, its disk numbering) and
   * its failure is non-fatal — the inventory must never answer empty because
   * format's interactive exit status misbehaves under the service user. A
   * diskinfo failure throws with the REAL error so the log names the cause.
   * @returns {Promise<Array>} Array of disk data objects
   */
  async collectDiskData() {
    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;

      const diskinfoOutput = await executeDiskinfo(timeout);
      if (typeof diskinfoOutput !== 'string' || !diskinfoOutput.trim()) {
        throw new Error('diskinfo answered no output');
      }
      const diskData = parseDiskinfoInventory(diskinfoOutput, this.hostname);
      if (diskData.length === 0) {
        throw new Error('diskinfo answered no parseable disk rows');
      }

      // Best-effort format enrichment (firmware + disk numbering)
      const formatOutput = await safeExecuteCommand(
        () => executeFormatList(timeout),
        'format disk list collection',
        log.monitoring,
        this.hostname
      );
      if (typeof formatOutput === 'string' && formatOutput.trim()) {
        applyFormatEnrichment(diskData, formatOutput, this.hostname);
      }

      // Cross-reference with zpool status to determine pool assignments
      const zpoolStatusOutput = await safeExecuteCommand(
        () => executeZpoolStatus(timeout),
        'zpool status for disk assignment',
        log.monitoring,
        this.hostname
      );

      if (typeof zpoolStatusOutput === 'string' && zpoolStatusOutput.trim()) {
        assignDisksToePools(diskData, zpoolStatusOutput);
      }

      // Store disk data in database with proper upsert using batch processing
      if (diskData.length > 0) {
        await this.batchProcessor.processBatches(diskData, batch =>
          Disks.bulkCreate(batch, {
            updateOnDuplicate: Object.keys(Disks.rawAttributes).filter(
              key => key !== 'id' && key !== 'createdAt'
            ),
            conflictAttributes: ['host', 'device_name'],
          })
        );
      }

      return diskData;
    } catch (error) {
      log.monitoring.error('Failed to collect disk data', {
        error: error.message,
        hostname: this.hostname,
      });
      throw error;
    }
  }
}

export default DiskCollector;
