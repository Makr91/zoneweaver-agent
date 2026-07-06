/**
 * @fileoverview Syslog service endpoints — reload the active syslog service
 * and switch between syslog implementations (syslog/rsyslog).
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';

const execProm = util.promisify(exec);

/**
 * @swagger
 * /system/syslog/reload:
 *   post:
 *     summary: Reload syslog service
 *     description: Reloads the syslog service to apply configuration changes
 *     tags: [Syslog Management]
 *     responses:
 *       200:
 *         description: Syslog service reloaded successfully
 *       503:
 *         description: System logs are disabled in configuration
 *       500:
 *         description: Failed to reload syslog service
 */
export const reloadSyslogService = async (req, res) => {
  void req;
  // Auto-detect syslog service (same logic as GET and PUT)
  let syslogService = 'svc:/system/system-log:default';

  try {
    const logsConfig = config.getSystemLogs();

    if (!logsConfig?.enabled) {
      return res.status(503).json({
        error: 'System logs are disabled in configuration',
      });
    }

    try {
      const { stdout: serviceCheck } = await execProm(
        'svcs svc:/system/system-log:rsyslog 2>/dev/null'
      );
      if (serviceCheck && serviceCheck.includes('online')) {
        syslogService = 'svc:/system/system-log:rsyslog';
      }
    } catch {
      // If rsyslog check fails, stick with default syslog
    }

    // Restart detected syslog service to reload configuration
    const { stdout, stderr } = await execProm(`pfexec svcadm restart ${syslogService}`, {
      timeout: 30000,
    });

    // Wait a moment and check service status
    await new Promise(resolve => {
      setTimeout(resolve, 2000);
    });

    const { stdout: statusOutput } = await execProm(`svcs ${syslogService}`);

    return res.json({
      success: true,
      message: `Syslog service reloaded successfully (${syslogService})`,
      service_fmri: syslogService,
      service_status: statusOutput.trim(),
      stdout,
      stderr: stderr || null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error reloading syslog service', {
      error: error.message,
      stack: error.stack,
      service: syslogService,
    });
    return res.status(500).json({
      error: 'Failed to reload syslog service',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/syslog/switch:
 *   post:
 *     summary: Switch between syslog implementations
 *     description: Switches between traditional syslog and rsyslog
 *     tags: [Syslog Management]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               target:
 *                 type: string
 *                 enum: [syslog, rsyslog]
 *                 description: Target syslog implementation
 *     responses:
 *       200:
 *         description: Syslog service switched successfully
 *       400:
 *         description: Invalid target or already using target
 *       503:
 *         description: System logs are disabled in configuration
 *       500:
 *         description: Failed to switch syslog service
 */
export const switchSyslogService = async (req, res) => {
  const { target } = req.body;
  let currentService = 'syslog';

  try {
    const logsConfig = config.getSystemLogs();

    if (!logsConfig?.enabled) {
      return res.status(503).json({
        error: 'System logs are disabled in configuration',
      });
    }

    if (!target || !['syslog', 'rsyslog'].includes(target)) {
      return res.status(400).json({
        error: 'target is required and must be either "syslog" or "rsyslog"',
      });
    }

    // Check current service
    try {
      const { stdout: serviceCheck } = await execProm(
        'svcs svc:/system/system-log:rsyslog 2>/dev/null'
      );
      if (serviceCheck && serviceCheck.includes('online')) {
        currentService = 'rsyslog';
      }
    } catch {
      // If rsyslog check fails, assume default syslog
    }

    if (currentService === target) {
      return res.status(400).json({
        error: `Already using ${target}`,
        current_service: currentService,
      });
    }

    const results = {
      current_service: currentService,
      target_service: target,
      old_service_disabled: false,
      new_service_enabled: false,
      warnings: [],
    };

    try {
      // Disable current service
      const currentFmri =
        currentService === 'rsyslog'
          ? 'svc:/system/system-log:rsyslog'
          : 'svc:/system/system-log:default';

      await execProm(`pfexec svcadm disable ${currentFmri}`);
      results.old_service_disabled = true;

      // Enable target service
      const targetFmri =
        target === 'rsyslog' ? 'svc:/system/system-log:rsyslog' : 'svc:/system/system-log:default';

      await execProm(`pfexec svcadm enable ${targetFmri}`);
      results.new_service_enabled = true;

      // Wait for service to come online
      await new Promise(resolve => {
        setTimeout(resolve, 3000);
      });

      return res.json({
        success: true,
        message: `Successfully switched from ${currentService} to ${target}`,
        results,
        new_service_fmri: targetFmri,
        config_file: target === 'rsyslog' ? '/etc/rsyslog.conf' : '/etc/syslog.conf',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      results.warnings.push(`Switch operation failed: ${error.message}`);

      return res.status(500).json({
        success: false,
        error: 'Failed to switch syslog service',
        details: error.message,
        partial_results: results,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    log.api.error('Error switching syslog service', {
      error: error.message,
      stack: error.stack,
      current: currentService,
      target,
    });
    return res.status(500).json({
      error: 'Failed to switch syslog service',
      details: error.message,
    });
  }
};
