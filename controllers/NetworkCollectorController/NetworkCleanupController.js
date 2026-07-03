/**
 * @fileoverview Network Cleanup Controller
 * @description Handles cleanup of old network data based on retention policies
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { Op } from 'sequelize';
import NetworkUsage from '../../models/NetworkUsageModel.js';
import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import IPAddresses from '../../models/IPAddressModel.js';
import Routes from '../../models/RoutingTableModel.js';
import { log } from '../../lib/Logger.js';

/**
 * Network Cleanup Controller Class
 * @description Manages cleanup of old network monitoring data
 */
export class NetworkCleanupController {
  constructor(hostMonitoringConfig) {
    this.hostMonitoringConfig = hostMonitoringConfig;
  }

  /**
   * Clean up old data based on retention policies
   */
  async cleanupOldData() {
    try {
      const retentionConfig = this.hostMonitoringConfig.retention;
      const now = new Date();

      // Clean network usage
      const usageRetentionDate = new Date(
        now.getTime() - retentionConfig.network_usage * 24 * 60 * 60 * 1000
      );
      const deletedUsage = await NetworkUsage.destroy({
        where: {
          scan_timestamp: { [Op.lt]: usageRetentionDate },
        },
      });

      // Clean network config
      const configRetentionDate = new Date(
        now.getTime() - retentionConfig.network_config * 24 * 60 * 60 * 1000
      );
      const deletedConfig = await NetworkInterfaces.destroy({
        where: {
          scan_timestamp: { [Op.lt]: configRetentionDate },
        },
      });

      // Clean IP addresses (using same retention as network config)
      const deletedIPAddresses = await IPAddresses.destroy({
        where: {
          scan_timestamp: { [Op.lt]: configRetentionDate },
        },
      });

      // Clean routing table (using same retention as network config)
      const deletedRoutes = await Routes.destroy({
        where: {
          scan_timestamp: { [Op.lt]: configRetentionDate },
        },
      });

      if (deletedUsage > 0 || deletedConfig > 0 || deletedIPAddresses > 0 || deletedRoutes > 0) {
        log.database.info('Network cleanup completed', {
          deleted_usage: deletedUsage,
          deleted_config: deletedConfig,
          deleted_ip_addresses: deletedIPAddresses,
          deleted_routes: deletedRoutes,
          retention_days: {
            usage: retentionConfig.network_usage,
            config: retentionConfig.network_config,
          },
        });
      }
    } catch (error) {
      log.database.error('Failed to cleanup old network data', {
        error: error.message,
        stack: error.stack,
      });
    }
  }
}

export default NetworkCleanupController;
