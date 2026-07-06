/**
 * @fileoverview Fault query endpoints
 */

import { exec } from 'child_process';
import util from 'util';
import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';
import { faultCache } from './utils/CacheHelper.js';
import {
  parseFaultOutput,
  parseFaultManagerConfig,
  generateFaultsSummary,
} from './utils/ParsingHelpers.js';

const execProm = util.promisify(exec);

/**
 * @swagger
 * /system/fault-management/faults:
 *   get:
 *     summary: Get system faults
 *     description: Returns current system faults from fmadm faulty
 *     tags: [Fault Management]
 *     parameters:
 *       - in: query
 *         name: all
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include all faults (including resolved ones)
 *       - in: query
 *         name: summary
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Return one-line summary format
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of faults to return
 *       - in: query
 *         name: force_refresh
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Force refresh of cached data
 *     responses:
 *       200:
 *         description: System faults data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 faults:
 *                   type: array
 *                   items:
 *                     type: object
 *                 summary:
 *                   type: object
 *                 raw_output:
 *                   type: string
 *                 cached:
 *                   type: boolean
 *                 last_updated:
 *                   type: string
 *                 cache_age_seconds:
 *                   type: integer
 *                   description: Age of the cached data in seconds (0 when freshly fetched)
 *       503:
 *         description: Fault management is disabled in configuration
 *       500:
 *         description: Failed to get system faults
 */
export const getFaults = async (req, res) => {
  try {
    // Explicitly parse boolean parameters to avoid string "false" being truthy
    const all = req.query.all === 'true' || req.query.all === true;
    const summary = req.query.summary === 'true' || req.query.summary === true;
    const limit = parseInt(req.query.limit) || 50;
    const force_refresh = req.query.force_refresh === 'true' || req.query.force_refresh === true;
    const faultConfig = config.getFaultManagement();

    if (!faultConfig?.enabled) {
      return res.status(503).json({
        error: 'Fault management is disabled in configuration',
      });
    }

    // Create cache key based on parameters to avoid conflicts
    const cacheKey = `all=${all}&summary=${summary}&limit=${limit}`;
    const now = Date.now();

    // Check cache validity for this specific parameter combination
    const cachedEntry = faultCache.get(cacheKey);
    const cacheAge = cachedEntry?.timestamp ? (now - cachedEntry.timestamp) / 1000 : Infinity;
    const useCache = !force_refresh && cachedEntry?.data && cacheAge < faultConfig.cache_interval;

    let faultData;

    if (useCache) {
      faultData = cachedEntry.data;
      log.monitoring.debug('Fault Management - Using cached data', { cache_key: cacheKey });
    } else {
      // Build fmadm command with options
      let command = 'pfexec fmadm faulty';
      if (all) {
        command += ' -a';
      }
      if (summary) {
        command += ' -s';
      }
      if (limit && limit < 50) {
        command += ` -n ${limit}`;
      }

      log.monitoring.debug('Fault Management - Parameters', {
        all,
        summary,
        limit,
        command,
        cache_key: cacheKey,
      });

      const { stdout, stderr } = await execProm(command, {
        timeout: faultConfig.timeout * 1000,
      });

      if (stderr && stderr.trim()) {
        log.monitoring.warn('fmadm faulty stderr', { stderr });
      }

      log.monitoring.debug('Fault Management - Raw output', {
        output_length: stdout.length,
        first_200_chars: stdout.substring(0, 200),
      });

      faultData = {
        raw_output: stdout,
        parsed_faults: parseFaultOutput(stdout),
        command_used: command,
        timestamp: new Date().toISOString(),
      };

      log.monitoring.debug('Fault Management - Parsed faults', {
        fault_count: faultData.parsed_faults.length,
      });

      // Update cache for this parameter combination
      faultCache.set(cacheKey, {
        data: faultData,
        timestamp: now,
      });
    }

    // Generate summary
    const faultsSummary = generateFaultsSummary(faultData.parsed_faults);

    return res.json({
      faults: faultData.parsed_faults,
      summary: faultsSummary,
      raw_output: faultData.raw_output,
      cached: useCache,
      last_updated: faultData.timestamp,
      cache_age_seconds: useCache ? Math.floor(cacheAge) : 0,
    });
  } catch (error) {
    log.api.error('Error getting system faults', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get system faults',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/fault-management/faults/{uuid}:
 *   get:
 *     summary: Get specific fault details
 *     description: Returns detailed information for a specific fault by UUID
 *     tags: [Fault Management]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: Fault UUID
 *     responses:
 *       200:
 *         description: Specific fault details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 fault:
 *                   type: object
 *                 raw_output:
 *                   type: string
 *                 uuid:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: Fault not found
 *       503:
 *         description: Fault management is disabled in configuration
 *       500:
 *         description: Failed to get fault details
 */
export const getFaultDetails = async (req, res) => {
  try {
    const { uuid } = req.params;
    const faultConfig = config.getFaultManagement();

    if (!faultConfig?.enabled) {
      return res.status(503).json({
        error: 'Fault management is disabled in configuration',
      });
    }

    const command = `pfexec fmadm faulty -v -u ${uuid}`;
    const { stdout, stderr } = await execProm(command, {
      timeout: faultConfig.timeout * 1000,
    });

    if (stderr && stderr.trim()) {
      log.monitoring.warn('fmadm faulty stderr for UUID', {
        uuid,
        stderr,
      });
    }

    if (!stdout.trim()) {
      return res.status(404).json({
        error: `Fault with UUID ${uuid} not found`,
      });
    }

    const [parsedFault] = parseFaultOutput(stdout); // Should only be one result

    return res.json({
      fault: parsedFault,
      raw_output: stdout,
      uuid,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error getting fault details', {
      uuid: req.params.uuid,
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get fault details',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/fault-management/config:
 *   get:
 *     summary: Get fault manager configuration
 *     description: Returns fault manager module configuration
 *     tags: [Fault Management]
 *     responses:
 *       200:
 *         description: Fault manager configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 config:
 *                   type: object
 *                 raw_output:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       503:
 *         description: Fault management is disabled in configuration
 *       500:
 *         description: Failed to get fault manager configuration
 */
export const getFaultManagerConfig = async (req, res) => {
  void req;
  try {
    const faultConfig = config.getFaultManagement();

    if (!faultConfig?.enabled) {
      return res.status(503).json({
        error: 'Fault management is disabled in configuration',
      });
    }

    const command = 'pfexec fmadm config';
    const { stdout, stderr } = await execProm(command, {
      timeout: faultConfig.timeout * 1000,
    });

    if (stderr && stderr.trim()) {
      log.monitoring.warn('fmadm config stderr', { stderr });
    }

    const parsedConfig = parseFaultManagerConfig(stdout);

    return res.json({
      config: parsedConfig,
      raw_output: stdout,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error getting fault manager configuration', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get fault manager configuration',
      details: error.message,
    });
  }
};
