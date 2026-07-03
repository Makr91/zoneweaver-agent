/**
 * @fileoverview Network Data Controller
 * @description Handles IP address and routing table data collection
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import IPAddresses from '../../models/IPAddressModel.js';
import Routes from '../../models/RoutingTableModel.js';
import NetworkParsingController from './NetworkParsingController.js';
import { log } from '../../lib/Logger.js';

const execProm = util.promisify(exec);

/**
 * Network Data Controller Class
 * @description Manages IP address and routing table data collection
 */
export class NetworkDataController {
  constructor(hostMonitoringConfig, hostManager) {
    this.hostMonitoringConfig = hostMonitoringConfig;
    this.hostManager = hostManager;
    this.parser = new NetworkParsingController();
  }

  /**
   * Collect IP address information
   * @description Gathers IP address assignments from ipadm show-addr
   */
  async collectIPAddresses() {
    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
      const { stdout } = await execProm('pfexec ipadm show-addr', { timeout });

      const ipData = this.parser.parseIPAddrOutput(stdout);

      if (ipData.length > 0) {
        // Delete existing IP address records for this host (current state replacement)
        await IPAddresses.destroy({
          where: {
            host: this.parser.hostname,
          },
        });

        // Insert fresh current state data in parallel batches
        const batchSize = this.hostMonitoringConfig.performance.batch_size;
        const batches = [];
        for (let i = 0; i < ipData.length; i += batchSize) {
          const batch = ipData.slice(i, i + batchSize);
          batches.push(IPAddresses.bulkCreate(batch));
        }
        await Promise.all(batches);

        log.monitoring.debug('IP addresses updated', {
          count: ipData.length,
          hostname: this.parser.hostname,
        });
      } else {
        // No IP addresses found - clear existing records
        await IPAddresses.destroy({
          where: {
            host: this.parser.hostname,
          },
        });
        log.monitoring.debug('IP addresses cleared (none found)', {
          hostname: this.parser.hostname,
        });
      }

      return ipData;
    } catch (error) {
      log.monitoring.warn('Failed to collect IP addresses', {
        error: error.message,
        hostname: this.parser.hostname,
      });
      return [];
    }
  }

  /**
   * Collect routing table information
   * @description Gathers routing table from netstat -rn
   */
  async collectRoutingTable() {
    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
      const { stdout } = await execProm('netstat -rn', { timeout });

      const routeData = this.parser.parseRoutingOutput(stdout);

      if (routeData.length > 0) {
        // Delete existing routing table records for this host (current state replacement)
        await Routes.destroy({
          where: {
            host: this.parser.hostname,
          },
        });

        // Insert fresh current state data in parallel batches
        const batchSize = this.hostMonitoringConfig.performance.batch_size;
        const batches = [];
        for (let i = 0; i < routeData.length; i += batchSize) {
          const batch = routeData.slice(i, i + batchSize);
          batches.push(Routes.bulkCreate(batch));
        }
        await Promise.all(batches);

        log.monitoring.debug('Routes updated', {
          count: routeData.length,
          hostname: this.parser.hostname,
        });
      } else {
        // No routes found - clear existing records
        await Routes.destroy({
          where: {
            host: this.parser.hostname,
          },
        });
        log.monitoring.debug('Routes cleared (none found)', {
          hostname: this.parser.hostname,
        });
      }

      return routeData;
    } catch (error) {
      log.monitoring.warn('Failed to collect routing table', {
        error: error.message,
        hostname: this.parser.hostname,
      });
      return [];
    }
  }
}

export default NetworkDataController;
