/**
 * @fileoverview System Update Controller for Zoneweaver Agent
 * @description Handles system update operations via pkg update commands
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { spawn } from 'child_process';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../lib/Logger.js';

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
const executeCommand = (
  command,
  timeout = 20 * 60 * 1000 // 20 minute default timeout ## THIS SHOULD NOT BE HARDCODED, THIS SHOULD USE CONFIG.YAML!!!
) =>
  new Promise(resolve => {
    const child = spawn('sh', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let completed = false;

    const timeoutId = setTimeout(() => {
      if (!completed) {
        completed = true;
        child.kill('SIGTERM');
        resolve({
          success: false,
          error: `Command timed out after ${timeout}ms`,
          output: stdout,
        });
      }
    }, timeout);

    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    child.on('close', code => {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutId);

        if (code === 0) {
          resolve({
            success: true,
            output: stdout.trim(),
          });
        } else {
          resolve({
            success: false,
            error: stderr.trim() || `Command exited with code ${code}`,
            output: stdout.trim(),
          });
        }
      }
    });

    child.on('error', error => {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutId);
        resolve({
          success: false,
          error: error.message,
          output: stdout,
        });
      }
    });
  });
/**
 * Parse changed packages section from pkg output
 * @param {Array} lines - Output lines
 * @param {number} startIndex - Index where "Changed packages:" was found
 * @returns {Array} Array of package objects
 */
const parseChangedPackages = (lines, startIndex) => {
  const packages = [];
  let currentPublisher = null;
  let currentPackage = null;

  for (let j = startIndex + 1; j < lines.length; j++) {
    const packageLine = lines[j];
    const packageTrimmed = packageLine.trim();

    if (!packageTrimmed) {
      continue;
    }

    // Publisher line (no leading spaces)
    if (!packageLine.startsWith(' ') && packageTrimmed.match(/^[a-zA-Z]/)) {
      currentPublisher = packageTrimmed;
    }
    // Package name line (2 spaces indentation)
    else if (
      packageLine.startsWith('  ') &&
      !packageLine.startsWith('    ') &&
      !packageTrimmed.includes('->')
    ) {
      currentPackage = packageTrimmed;
    }
    // Version line (4+ spaces indentation, contains ->)
    else if (packageLine.startsWith('    ') && packageTrimmed.includes('->')) {
      const versionMatch = packageTrimmed.match(/(?<current>\S+)\s*->\s*(?<new>\S+)/);
      if (versionMatch && currentPublisher && currentPackage) {
        packages.push({
          name: currentPackage,
          publisher: currentPublisher,
          current_version: versionMatch.groups.current,
          new_version: versionMatch.groups.new,
        });
      }
    }
  }

  return packages;
};

/**
 * Parse pkg update -nv output to extract update information
 * @param {string} output - Raw pkg update -nv output
 * @returns {Object} Parsed update information
 */
const parseUpdateCheckOutput = output => {
  const lines = output.split('\n');
  const planSummary = {
    packages_to_install: 0,
    packages_to_update: 0,
    packages_to_remove: 0,
    estimated_space_available: null,
    estimated_space_consumed: null,
  };

  const bootEnvironment = {
    create_boot_environment: false,
    create_backup_boot_environment: false,
    rebuild_boot_archive: false,
  };

  let packages = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Parse summary numbers with named capture groups
    if (trimmed.includes('Packages to install:')) {
      const match = trimmed.match(/Packages to install:\s*(?<count>\d+)/);
      if (match) {
        planSummary.packages_to_install = parseInt(match.groups.count);
      }
    } else if (trimmed.includes('Packages to update:')) {
      const match = trimmed.match(/Packages to update:\s*(?<count>\d+)/);
      if (match) {
        planSummary.packages_to_update = parseInt(match.groups.count);
      }
    } else if (trimmed.includes('Packages to remove:')) {
      const match = trimmed.match(/Packages to remove:\s*(?<count>\d+)/);
      if (match) {
        planSummary.packages_to_remove = parseInt(match.groups.count);
      }
    }

    // Parse space information
    else if (trimmed.includes('Estimated space available:')) {
      const match = trimmed.match(/Estimated space available:\s*(?<space>.+)/);
      if (match) {
        planSummary.estimated_space_available = match.groups.space.trim();
      }
    } else if (trimmed.includes('Estimated space to be consumed:')) {
      const match = trimmed.match(/Estimated space to be consumed:\s*(?<space>.+)/);
      if (match) {
        planSummary.estimated_space_consumed = match.groups.space.trim();
      }
    }

    // Parse boot environment information
    else if (trimmed.includes('Create boot environment:')) {
      const match = trimmed.match(/Create boot environment:\s*(?<status>\w+)/);
      if (match) {
        bootEnvironment.create_boot_environment = match.groups.status.toLowerCase() === 'yes';
      }
    } else if (trimmed.includes('Create backup boot environment:')) {
      const match = trimmed.match(/Create backup boot environment:\s*(?<status>\w+)/);
      if (match) {
        bootEnvironment.create_backup_boot_environment =
          match.groups.status.toLowerCase() === 'yes';
      }
    } else if (trimmed.includes('Rebuild boot archive:')) {
      const match = trimmed.match(/Rebuild boot archive:\s*(?<status>\w+)/);
      if (match) {
        bootEnvironment.rebuild_boot_archive = match.groups.status.toLowerCase() === 'yes';
      }
    }

    // Parse changed packages section
    else if (trimmed === 'Changed packages:') {
      packages = parseChangedPackages(lines, i);
      break;
    }
  }

  return {
    updates_available: packages.length > 0,
    total_updates: packages.length,
    packages,
    plan_summary: planSummary,
    boot_environment: bootEnvironment,
    raw_output: output,
  };
};

/**
 * @swagger
 * /system/updates/check:
 *   get:
 *     summary: Check for system updates
 *     description: Check for available system updates using pkg update -n (dry run)
 *     tags: [System Updates]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [structured, raw]
 *           default: structured
 *         description: Response format (structured or raw output)
 *     responses:
 *       200:
 *         description: Update check completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 updates_available:
 *                   type: boolean
 *                 total_updates:
 *                   type: integer
 *                 packages:
 *                   type: array
 *                   items:
 *                     type: string
 *                 plan_summary:
 *                   type: object
 *                   properties:
 *                     packages_to_install:
 *                       type: integer
 *                     packages_to_update:
 *                       type: integer
 *                     packages_to_remove:
 *                       type: integer
 *                     total_download_size:
 *                       type: string
 *                 last_checked:
 *                   type: string
 *                   format: date-time
 *       500:
 *         description: Failed to check for updates
 */
export const checkForUpdates = async (req, res) => {
  try {
    const { format = 'structured' } = req.query;

    log.monitoring.info('Checking for system updates', {
      format,
    });
    const result = await executeCommand('pfexec pkg update -nv');

    if (format === 'raw') {
      return res.json({
        success: result.success,
        raw_output: result.output,
        error: result.error,
        last_checked: new Date().toISOString(),
      });
    }

    if (!result.success) {
      // pkg update -n can return non-zero even when successful if no updates
      // Check if output contains useful information anyway
      if (
        result.output &&
        (result.output.includes('No updates available') ||
          result.output.includes('No packages installed'))
      ) {
        return res.json({
          updates_available: false,
          total_updates: 0,
          packages: [],
          plan_summary: {
            packages_to_install: 0,
            packages_to_update: 0,
            packages_to_remove: 0,
            total_download_size: null,
          },
          message: 'No updates available',
          last_checked: new Date().toISOString(),
        });
      }

      return res.status(500).json({
        error: 'Failed to check for updates',
        details: result.error,
        output: result.output,
      });
    }

    const updateInfo = parseUpdateCheckOutput(result.output);

    return res.json({
      ...updateInfo,
      last_checked: new Date().toISOString(),
    });
  } catch (error) {
    log.monitoring.error('Error checking for updates', {
      error: error.message,
      stack: error.stack,
      format: req.query.format,
    });
    return res.status(500).json({
      error: 'Failed to check for updates',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/updates/install:
 *   post:
 *     summary: Install system updates
 *     description: Install available system updates using pkg update
 *     tags: [System Updates]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               packages:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Specific packages to update (optional, updates all if not specified)
 *               accept_licenses:
 *                 type: boolean
 *                 default: false
 *                 description: Accept package licenses automatically
 *               be_name:
 *                 type: string
 *                 description: Boot environment name to create for updates
 *               backup_be:
 *                 type: boolean
 *                 default: true
 *                 description: Create backup boot environment
 *               reject_packages:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Package patterns to reject during update
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this task
 *     responses:
 *       202:
 *         description: System update task created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 task_id:
 *                   type: string
 *                 packages:
 *                   type: array
 *                   items:
 *                     type: string
 *       500:
 *         description: Failed to create update task
 */
export const installUpdates = async (req, res) => {
  try {
    const {
      packages = [],
      accept_licenses = false,
      be_name,
      backup_be = true,
      reject_packages = [],
      created_by = 'api',
    } = req.body || {};

    // Create task for system update
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'pkg_update',
      priority: TaskPriority.HIGH,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            packages,
            accept_licenses,
            be_name,
            backup_be,
            reject_packages,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message:
        packages.length > 0
          ? `System update task created for ${packages.length} specific package(s)`
          : 'System update task created for all available updates',
      task_id: task.id,
      packages,
      backup_be,
      be_name: be_name || 'auto-generated',
    });
  } catch (error) {
    log.api.error('Error creating system update task', {
      error: error.message,
      stack: error.stack,
      packages: req.body?.packages,
      backup_be: req.body?.backup_be,
      created_by: req.body?.created_by,
    });
    return res.status(500).json({
      error: 'Failed to create system update task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/updates/history:
 *   get:
 *     summary: Get update history
 *     description: Get history of package operations using pkg history
 *     tags: [System Updates]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Maximum number of history entries to return
 *       - in: query
 *         name: operation
 *         schema:
 *           type: string
 *           enum: [install, update, uninstall]
 *         description: Filter by operation type
 *     responses:
 *       200:
 *         description: Update history retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 history:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 raw_output:
 *                   type: string
 *       500:
 *         description: Failed to get update history
 */
export const getUpdateHistory = async (req, res) => {
  try {
    const { limit = 20, operation } = req.query;

    let command = 'pfexec pkg history -H';

    if (limit) {
      command += ` -n ${limit}`;
    }

    const result = await executeCommand(command);

    if (!result.success) {
      return res.status(500).json({
        error: 'Failed to get update history',
        details: result.error,
      });
    }

    // Parse history output
    const lines = result.output.split('\n').filter(line => line.trim());
    const history = [];

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 4) {
        const entry = {
          start_time: parts[0],
          operation_name: parts[1],
          client: parts[2],
          outcome: parts[3],
        };

        // Filter by operation if specified
        if (!operation || entry.operation_name.toLowerCase().includes(operation.toLowerCase())) {
          history.push(entry);
        }
      }
    }

    return res.json({
      history,
      total: history.length,
      limit: parseInt(limit),
      operation_filter: operation || null,
      raw_output: result.output,
    });
  } catch (error) {
    log.monitoring.error('Error getting update history', {
      error: error.message,
      stack: error.stack,
      limit: req.query.limit,
      operation: req.query.operation,
    });
    return res.status(500).json({
      error: 'Failed to get update history',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/updates/refresh:
 *   post:
 *     summary: Refresh package metadata
 *     description: Refresh package repository metadata using pkg refresh
 *     tags: [System Updates]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               full:
 *                 type: boolean
 *                 default: false
 *                 description: Force full retrieval of all metadata
 *               publishers:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Specific publishers to refresh (optional)
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this task
 *     responses:
 *       202:
 *         description: Metadata refresh task created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 task_id:
 *                   type: string
 *       500:
 *         description: Failed to create refresh task
 */
export const refreshMetadata = async (req, res) => {
  try {
    const { full = false, publishers = [], created_by = 'api' } = req.body || {};

    // Create task for metadata refresh
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'pkg_refresh',
      priority: TaskPriority.LOW,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            full,
            publishers,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message:
        publishers.length > 0
          ? `Metadata refresh task created for ${publishers.length} publisher(s)`
          : 'Metadata refresh task created for all publishers',
      task_id: task.id,
      full,
      publishers,
    });
  } catch (error) {
    log.api.error('Error creating metadata refresh task', {
      error: error.message,
      stack: error.stack,
      full: req.body?.full,
      publishers: req.body?.publishers,
      created_by: req.body?.created_by,
    });
    return res.status(500).json({
      error: 'Failed to create metadata refresh task',
      details: error.message,
    });
  }
};
