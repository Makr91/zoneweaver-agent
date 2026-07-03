/**
 * @fileoverview ZFS Dataset Data Collection Module
 * @description Handles ZFS dataset information collection and processing
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import ZFSDatasets from '../../models/ZFSDatasetModel.js';
import { log } from '../../lib/Logger.js';
import { parseDatasetListOutput, parseDatasetPropertiesOutput } from './utils/ParsingUtils.js';
import {
  executeZfsList,
  executeZfsGetAll,
  executeZfsListDataset,
  safeExecuteCommand,
} from './utils/CommandUtils.js';
import { BatchProcessor, filterZoneDatasets } from './utils/HostUtils.js';

/**
 * ZFS Dataset Data Collector Class
 * @description Handles collection of ZFS dataset information
 */
class DatasetCollector {
  constructor(hostname, hostMonitoringConfig) {
    this.hostname = hostname;
    this.hostMonitoringConfig = hostMonitoringConfig;
    this.batchProcessor = new BatchProcessor(hostMonitoringConfig.performance.batch_size);
  }

  /**
   * Collect ZFS dataset information for zones/VMs only
   * @description Gathers dataset list and detailed properties for zone-related datasets only
   * @param {Set} discoveredZones - Set of discovered zone names
   * @returns {Promise<Array>} Array of dataset data objects
   */
  async collectDatasetData(discoveredZones) {
    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;

      // Get basic dataset list
      const listOutput = await safeExecuteCommand(
        () => executeZfsList(timeout),
        'zfs list data collection',
        log.monitoring,
        this.hostname
      );

      if (!listOutput) {
        return [];
      }

      const allDatasets = parseDatasetListOutput(listOutput, this.hostname);

      // Filter to only zone/VM-related datasets
      const zoneDatasets = filterZoneDatasets(allDatasets, discoveredZones);

      if (zoneDatasets.length === 0) {
        return [];
      }

      // Collect detailed properties for all zone datasets in parallel for better performance
      const datasetPromises = zoneDatasets.map(dataset =>
        this.collectDatasetDetails(dataset, timeout)
      );
      const detailedDatasets = await Promise.all(datasetPromises);

      // Store dataset data in database using batch processing
      if (detailedDatasets.length > 0) {
        await this.batchProcessor.processBatches(detailedDatasets, batch =>
          ZFSDatasets.bulkCreate(batch, {
            updateOnDuplicate: Object.keys(ZFSDatasets.rawAttributes).filter(key => key !== 'id'),
          })
        );
      }

      return detailedDatasets;
    } catch (error) {
      log.monitoring.error('Failed to collect dataset data', {
        error: error.message,
        hostname: this.hostname,
      });
      throw error;
    }
  }

  /**
   * Collect detailed properties for a single dataset
   * @param {Object} dataset - Basic dataset information
   * @param {number} timeout - Command timeout in milliseconds
   * @returns {Promise<Object>} Detailed dataset information
   */
  async collectDatasetDetails(dataset, timeout) {
    // First verify the dataset still exists
    let datasetExists = false;

    try {
      await executeZfsListDataset(dataset.name, timeout);
      datasetExists = true;
    } catch (listError) {
      log.monitoring.debug('Dataset no longer exists, skipping detailed properties', {
        dataset: dataset.name,
        hostname: this.hostname,
        error: listError.message,
      });
      datasetExists = false;
    }

    if (!datasetExists) {
      // Still include basic dataset info but mark it as non-existent
      return {
        ...dataset,
        dataset_exists: false,
      };
    }

    // Dataset exists, try to get detailed properties
    try {
      const propsOutput = await executeZfsGetAll(dataset.name, timeout);
      const detailedProps = parseDatasetPropertiesOutput(propsOutput, dataset.name, this.hostname);

      // Merge basic and detailed data
      return {
        ...dataset,
        ...detailedProps,
        dataset_exists: true,
      };
    } catch (error) {
      log.monitoring.warn('Failed to get detailed properties for dataset', {
        dataset: dataset.name,
        error: error.message,
        hostname: this.hostname,
      });
      // Still include basic dataset info
      return {
        ...dataset,
        dataset_exists: false,
      };
    }
  }
}

export default DatasetCollector;
