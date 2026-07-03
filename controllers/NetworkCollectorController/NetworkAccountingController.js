/**
 * @fileoverview Network Accounting Controller
 * @description Handles network accounting initialization and management using acctadm
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import os from 'os';
import HostInfo from '../../models/HostInfoModel.js';
import { log } from '../../lib/Logger.js';

const execProm = util.promisify(exec);

/**
 * Network Accounting Controller Class
 * @description Manages network accounting using OmniOS acctadm functionality
 */
export class NetworkAccountingController {
  constructor(hostMonitoringConfig) {
    this.hostMonitoringConfig = hostMonitoringConfig;
    this.hostname = os.hostname();
  }

  /**
   * Initialize network accounting if not already enabled
   * @description Enables network accounting using acctadm if auto_enable_network_accounting is true
   */
  async initializeNetworkAccounting() {
    if (!this.hostMonitoringConfig.auto_enable_network_accounting) {
      return false;
    }

    try {
      // Check if network accounting is already enabled
      const { stdout } = await execProm('pfexec acctadm net', { timeout: 10000 });

      if (stdout.includes('Net accounting: active')) {
        await this.updateHostInfo({ network_acct_enabled: true });
        return true;
      }

      // Enable network accounting
      const acctFile = this.hostMonitoringConfig.network_accounting_file;

      await execProm(`pfexec acctadm -e basic -f ${acctFile} net`, { timeout: 10000 });

      // Verify it was enabled
      const { stdout: verifyOutput } = await execProm('pfexec acctadm net', { timeout: 10000 });
      const enabled = verifyOutput.includes('Net accounting: active');

      await this.updateHostInfo({
        network_acct_enabled: enabled,
        network_acct_file: enabled ? acctFile : null,
      });

      if (enabled) {
        log.monitoring.info('Network accounting enabled successfully', {
          hostname: this.hostname,
          acct_file: acctFile,
        });
        return true;
      }

      log.monitoring.warn('Network accounting enable command succeeded but verification failed', {
        hostname: this.hostname,
        acct_file: acctFile,
      });
      return false;
    } catch (error) {
      log.monitoring.error('Failed to initialize network accounting', {
        error: error.message,
        hostname: this.hostname,
        acct_file: this.hostMonitoringConfig.network_accounting_file,
      });
      await this.updateHostInfo({
        network_acct_enabled: false,
        last_error_message: `Network accounting init failed: ${error.message}`,
      });
      return false;
    }
  }

  /**
   * Update host information record
   * @param {Object} updates - Fields to update
   */
  async updateHostInfo(updates) {
    try {
      await HostInfo.upsert({
        host: this.hostname,
        hostname: this.hostname,
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        uptime: Math.floor(os.uptime()),
        ...updates,
        updated_at: new Date(),
      });
    } catch (error) {
      log.database.error('Failed to update host info', {
        error: error.message,
        hostname: this.hostname,
        updates: Object.keys(updates),
      });
    }
  }
}

export default NetworkAccountingController;
