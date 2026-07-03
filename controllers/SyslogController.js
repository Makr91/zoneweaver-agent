/**
 * @fileoverview Syslog Configuration Controller for Zoneweaver Agent
 * @description Provides API endpoints for managing syslog configuration
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import fs from 'fs/promises';
import config from '../config/ConfigLoader.js';
import { getServiceDetails } from '../lib/ServiceManager.js';
import { log } from '../lib/Logger.js';

const execProm = util.promisify(exec);

/**
 * Helper function to parse selector and action
 * @param {string} selector - Selector part (e.g., "*.notice;mail.none")
 * @param {string} action - Action part (e.g., "/var/log/messages")
 * @returns {Object} Parsed selector and action
 */
const parseSelectorAndAction = (selector, action) => {
  const parsed = {
    selectors: [],
    action_type: 'unknown',
    action_target: action,
  };

  // Parse selectors (semicolon separated)
  const selectorParts = selector.split(';');

  for (const part of selectorParts) {
    const trimmed = part.trim();
    if (trimmed.includes('.')) {
      const [facility, level] = trimmed.split('.');
      parsed.selectors.push({
        facility,
        level,
      });
    } else {
      parsed.selectors.push({
        facility: trimmed,
        level: null,
      });
    }
  }

  // Determine action type
  if (action.startsWith('/')) {
    parsed.action_type = 'file';
  } else if (action.startsWith('@')) {
    parsed.action_type = 'remote_host';
    parsed.action_target = action.substring(1);
  } else if (action === '*') {
    parsed.action_type = 'all_users';
  } else if (action.includes(',')) {
    parsed.action_type = 'specific_users';
    parsed.action_target = action.split(',').map(u => u.trim());
  } else {
    parsed.action_type = 'user';
  }

  return parsed;
};

/**
 * Helper function to parse syslog configuration
 * @param {string} configContent - Syslog configuration content
 * @returns {Array} Parsed rules
 */
const parseSyslogConfig = configContent => {
  const rules = [];

  if (!configContent) {
    return rules;
  }

  const lines = configContent.split('\n');

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum].trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) {
      continue;
    }

    // Parse selector and action (separated by TAB or multiple spaces)
    const parts = line.split(/\t+|\s{2,}/);
    if (parts.length >= 2) {
      const [selector, ...actionParts] = parts;
      const action = actionParts.join(' ');

      rules.push({
        line_number: lineNum + 1,
        selector,
        action,
        full_line: line,
        parsed: parseSelectorAndAction(selector, action),
      });
    } else {
      rules.push({
        line_number: lineNum + 1,
        full_line: line,
        error: 'Could not parse selector and action',
      });
    }
  }

  return rules;
};

/**
 * Helper function to validate syslog configuration
 * @param {string} configContent - Configuration content to validate
 * @returns {Object} Validation result
 */
const validateSyslogConfigContent = configContent => {
  const errors = [];
  const warnings = [];
  const parsedRules = [];

  if (!configContent) {
    return { valid: true, errors, warnings, parsed_rules: parsedRules };
  }

  const lines = configContent.split('\n');
  const knownFacilities = [
    'kern',
    'user',
    'mail',
    'daemon',
    'auth',
    'lpr',
    'news',
    'uucp',
    'altcron',
    'authpriv',
    'ftp',
    'ntp',
    'audit',
    'console',
    'cron',
    'local0',
    'local1',
    'local2',
    'local3',
    'local4',
    'local5',
    'local6',
    'local7',
    'mark',
    '*',
  ];
  const knownLevels = [
    'emerg',
    'alert',
    'crit',
    'err',
    'warning',
    'notice',
    'info',
    'debug',
    'none',
  ];

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum].trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) {
      continue;
    }

    // Check for TAB separation
    if (!line.includes('\t') && !line.match(/\s{2,}/)) {
      warnings.push(`Line ${lineNum + 1}: Should use TAB to separate selector from action`);
    }

    // Parse rule
    const parts = line.split(/\t+|\s{2,}/);
    if (parts.length < 2) {
      errors.push(`Line ${lineNum + 1}: Missing action field`);
      continue;
    }

    const [selector, ...actionParts] = parts;
    const action = actionParts.join(' ');

    // Validate selectors
    const selectors = selector.split(';');
    for (const sel of selectors) {
      const trimmed = sel.trim();
      if (trimmed.includes('.')) {
        const [facility, level] = trimmed.split('.');

        if (!knownFacilities.includes(facility)) {
          warnings.push(`Line ${lineNum + 1}: Unknown facility '${facility}'`);
        }

        if (!knownLevels.includes(level)) {
          errors.push(`Line ${lineNum + 1}: Unknown level '${level}'`);
        }
      }
    }

    // Validate action
    if (action.startsWith('/')) {
      // File path - check if directory exists
      const dir = action.substring(0, action.lastIndexOf('/'));
      if (!dir) {
        warnings.push(`Line ${lineNum + 1}: File path should be absolute`);
      }
    } else if (action.startsWith('@')) {
      // Remote host
      const hostname = action.substring(1);
      if (!hostname) {
        errors.push(`Line ${lineNum + 1}: Remote host name required after @`);
      }
    } else if (action !== '*' && !action.match(/^[a-zA-Z][a-zA-Z0-9_,]*$/)) {
      warnings.push(`Line ${lineNum + 1}: Action '${action}' may not be valid`);
    }

    parsedRules.push(parseSelectorAndAction(selector, action));
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    parsed_rules: parsedRules,
  };
};

/**
 * @swagger
 * /system/syslog/config:
 *   get:
 *     summary: Get syslog configuration
 *     description: Returns current syslog.conf configuration
 *     tags: [Syslog Management]
 *     responses:
 *       200:
 *         description: Syslog configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 config_content:
 *                   type: string
 *                 parsed_rules:
 *                   type: array
 *                 service_status:
 *                   type: object
 *                 config_file:
 *                   type: string
 *       500:
 *         description: Failed to get syslog configuration
 */
export const getSyslogConfig = async (req, res) => {
  void req;
  // Auto-detect syslog service and corresponding config file
  let syslogService = 'svc:/system/system-log:default';
  let configFile = '/etc/syslog.conf';

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
        configFile = '/etc/rsyslog.conf';
      }
    } catch {
      // If rsyslog check fails, stick with default syslog
    }

    // Read current configuration
    let configContent = '';
    let configExists = false;

    try {
      configContent = await fs.readFile(configFile, 'utf8');
      configExists = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error; // Re-throw if it's not a "file not found" error
      }
    }

    // Get syslog service status using existing ServiceManager
    const serviceStatus = await getServiceDetails(syslogService);

    // Parse configuration into structured rules
    const parsedRules = parseSyslogConfig(configContent);

    return res.json({
      config_content: configContent,
      parsed_rules: parsedRules,
      config_exists: configExists,
      config_file: configFile,
      service_fmri: syslogService,
      service_status: serviceStatus,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error getting syslog configuration', {
      error: error.message,
      stack: error.stack,
      config_file: configFile,
      service: syslogService,
    });
    return res.status(500).json({
      error: 'Failed to get syslog configuration',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/syslog/config:
 *   put:
 *     summary: Update syslog configuration
 *     description: Updates syslog.conf and reloads the service
 *     tags: [Syslog Management]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               config_content:
 *                 type: string
 *                 description: Complete syslog.conf content
 *               backup_existing:
 *                 type: boolean
 *                 default: true
 *                 description: Create backup of existing config
 *               reload_service:
 *                 type: boolean
 *                 default: true
 *                 description: Reload syslog service after update
 *     responses:
 *       200:
 *         description: Syslog configuration updated successfully
 *       400:
 *         description: Invalid configuration content
 *       500:
 *         description: Failed to update syslog configuration
 */
export const updateSyslogConfig = async (req, res) => {
  // Auto-detect syslog service and corresponding config file (same logic as GET)
  let syslogService = 'svc:/system/system-log:default';
  let configFile = '/etc/syslog.conf';

  try {
    const { config_content, backup_existing = true, reload_service = true } = req.body;
    const logsConfig = config.getSystemLogs();

    if (!logsConfig?.enabled) {
      return res.status(503).json({
        error: 'System logs are disabled in configuration',
      });
    }

    if (!config_content || typeof config_content !== 'string') {
      return res.status(400).json({
        error: 'config_content is required and must be a string',
      });
    }

    try {
      const { stdout: serviceCheck } = await execProm(
        'svcs svc:/system/system-log:rsyslog 2>/dev/null'
      );
      if (serviceCheck && serviceCheck.includes('online')) {
        syslogService = 'svc:/system/system-log:rsyslog';
        configFile = '/etc/rsyslog.conf';
      }
    } catch {
      // If rsyslog check fails, stick with default syslog
    }

    // Validate configuration syntax
    const validationResult = validateSyslogConfigContent(config_content);
    if (!validationResult.valid) {
      return res.status(400).json({
        error: 'Invalid syslog configuration',
        details: validationResult.errors,
      });
    }

    const results = {
      backup_created: false,
      config_updated: false,
      service_reloaded: false,
      warnings: [],
      service_fmri: syslogService,
      config_file: configFile,
    };

    // Create backup if requested and file exists
    if (backup_existing) {
      try {
        await fs.access(configFile);
        const backupFile = `${configFile}.backup.${Date.now()}`;
        await execProm(`pfexec cp "${configFile}" "${backupFile}"`);
        results.backup_created = true;
        results.backup_file = backupFile;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          results.warnings.push(`Failed to create backup: ${error.message}`);
        }
      }
    }

    // Write new configuration
    const tempFile = `/tmp/syslog.conf.tmp.${Date.now()}`;
    await fs.writeFile(tempFile, config_content, 'utf8');

    // Move to final location with proper permissions
    await execProm(`pfexec mv "${tempFile}" "${configFile}"`);
    await execProm(`pfexec chmod 644 "${configFile}"`);

    results.config_updated = true;

    // Reload syslog service if requested
    if (reload_service) {
      try {
        const { stderr } = await execProm(`pfexec svcadm restart ${syslogService}`, {
          timeout: 30000,
        });
        results.service_reloaded = true;
        if (stderr) {
          results.warnings.push(`Service restart stderr: ${stderr}`);
        }
      } catch (error) {
        results.warnings.push(`Failed to reload syslog service: ${error.message}`);
      }
    }

    return res.json({
      success: true,
      message: 'Syslog configuration updated successfully',
      results,
      parsed_rules: parseSyslogConfig(config_content),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error updating syslog configuration', {
      error: error.message,
      stack: error.stack,
      config_file: configFile,
      service: syslogService,
    });
    return res.status(500).json({
      error: 'Failed to update syslog configuration',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/syslog/facilities:
 *   get:
 *     summary: Get available syslog facilities and levels
 *     description: Returns list of available syslog facilities and severity levels
 *     tags: [Syslog Management]
 *     responses:
 *       200:
 *         description: Available facilities and levels
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 facilities:
 *                   type: array
 *                 levels:
 *                   type: array
 *       500:
 *         description: Failed to get facilities
 */
export const getSyslogFacilities = (req, res) => {
  void req;
  try {
    const facilities = [
      { name: 'kern', description: 'Messages generated by the kernel' },
      { name: 'user', description: 'Messages generated by user processes (default)' },
      { name: 'mail', description: 'The mail system' },
      { name: 'daemon', description: 'Various system daemons' },
      { name: 'auth', description: 'The authorization system (login, su, getty)' },
      { name: 'lpr', description: 'Line printer spooling system' },
      { name: 'news', description: 'USENET network news system' },
      { name: 'uucp', description: 'UUCP system' },
      { name: 'altcron', description: 'BSD cron/at system' },
      { name: 'authpriv', description: 'BSD security/authorization system' },
      { name: 'ftp', description: 'File transfer system' },
      { name: 'ntp', description: 'Network time system' },
      { name: 'audit', description: 'Audit messages' },
      { name: 'console', description: 'BSD console system' },
      { name: 'cron', description: 'Cron/at messages' },
      { name: 'local0', description: 'Local use facility 0' },
      { name: 'local1', description: 'Local use facility 1' },
      { name: 'local2', description: 'Local use facility 2' },
      { name: 'local3', description: 'Local use facility 3' },
      { name: 'local4', description: 'Local use facility 4' },
      { name: 'local5', description: 'Local use facility 5' },
      { name: 'local6', description: 'Local use facility 6' },
      { name: 'local7', description: 'Local use facility 7' },
      { name: 'mark', description: 'Timestamp messages (internal)' },
      { name: '*', description: 'All facilities except mark' },
    ];

    const levels = [
      { name: 'emerg', value: 0, description: 'Panic conditions broadcast to all users' },
      { name: 'alert', value: 1, description: 'Conditions requiring immediate correction' },
      { name: 'crit', value: 2, description: 'Critical conditions (hard device errors)' },
      { name: 'err', value: 3, description: 'Other errors' },
      { name: 'warning', value: 4, description: 'Warning messages' },
      { name: 'notice', value: 5, description: 'Conditions requiring special handling' },
      { name: 'info', value: 6, description: 'Informational messages' },
      { name: 'debug', value: 7, description: 'Debug messages' },
      { name: 'none', value: -1, description: 'Do not log messages from this facility' },
    ];

    return res.json({
      facilities,
      levels,
      example_rules: [
        '*.notice\t\t\t/var/log/notice',
        'mail.info\t\t\t/var/log/maillog',
        '*.crit\t\t\t\t/var/log/critical',
        'kern.err\t\t\t@loghost',
        '*.emerg\t\t\t\t*',
        '*.alert\t\t\t\troot,operator',
      ],
      syntax_notes: [
        'Use TAB to separate selector from action',
        'Multiple facilities: kern,mail.info',
        'Multiple selectors: *.notice;mail.none',
        'Actions: filename, @hostname, username, *',
      ],
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error getting syslog facilities', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get syslog facilities',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/syslog/validate:
 *   post:
 *     summary: Validate syslog configuration
 *     description: Validates syslog configuration without applying it
 *     tags: [Syslog Management]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               config_content:
 *                 type: string
 *                 description: Syslog configuration to validate
 *     responses:
 *       200:
 *         description: Validation results
 *       400:
 *         description: Invalid configuration
 */
export const validateSyslogConfig = (req, res) => {
  try {
    const { config_content } = req.body;

    if (!config_content || typeof config_content !== 'string') {
      return res.status(400).json({
        error: 'config_content is required and must be a string',
      });
    }

    const validationResult = validateSyslogConfigContent(config_content);

    return res.json({
      valid: validationResult.valid,
      errors: validationResult.errors,
      warnings: validationResult.warnings,
      parsed_rules: validationResult.parsed_rules,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error validating syslog configuration', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to validate syslog configuration',
      details: error.message,
    });
  }
};

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

export default {
  getSyslogConfig,
  updateSyslogConfig,
  getSyslogFacilities,
  validateSyslogConfig,
  reloadSyslogService,
};
