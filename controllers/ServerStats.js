import os from 'os';
import util from 'util';
import { exec } from 'child_process';
import { log } from '../lib/Logger.js';
const execProm = util.promisify(exec);

/**
 * @swagger
 * /stats:
 *   get:
 *     summary: Get server statistics and zone information
 *     description: Returns comprehensive system information including OS details, hardware specs, and OmniOS zone status. Access may be public or require API key based on configuration.
 *     tags: [System]
 *     security: []
 *     responses:
 *       200:
 *         description: Server statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ServerStats'
 *       401:
 *         description: API key required (if stats.public_access is false)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Invalid API key (if stats.public_access is false)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Failed to retrieve server statistics
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export const serverStats = async (req, res) => {
  void req;
  try {
    const returnObject = {};

    // Basic OS information. Deliberately omits networkInterfaces (host IPs/MACs),
    // homedir (local path disclosure), and os.constants/devNull/tmpdir (noise) —
    // this endpoint can be public, and those leak host internals for no consumer
    // (network data has its own authed monitoring/network/* endpoints).
    returnObject.hostname = os.hostname();
    returnObject.eol = os.EOL;
    returnObject.arch = os.arch();
    returnObject.cpus = os.cpus();
    returnObject.endianness = os.endianness();
    returnObject.freemem = os.freemem();
    returnObject.loadavg = os.loadavg();
    returnObject.platform = os.platform();
    returnObject.release = os.release();
    returnObject.totalmem = os.totalmem();
    returnObject.type = os.type();
    returnObject.uptime = os.uptime();
    returnObject.version = os.version();

    // Zone information with proper error handling
    try {
      const { stdout: allzones } = await execProm('zoneadm list -ic | grep -v global');
      returnObject.allzones = allzones
        .trim()
        .split('\n')
        .filter(line => line.trim() !== '');
    } catch (error) {
      log.monitoring.warn('Failed to get all zones', {
        error: error.message,
        command: 'zoneadm list -ic | grep -v global',
      });
      returnObject.allzones = [];
    }

    try {
      const { stdout: runningzones } = await execProm('zoneadm list | grep -v global');
      returnObject.runningzones = runningzones
        .trim()
        .split('\n')
        .filter(line => line.trim() !== '');
    } catch (error) {
      log.monitoring.warn('Failed to get running zones', {
        error: error.message,
        command: 'zoneadm list | grep -v global',
      });
      returnObject.runningzones = [];
    }

    res.json(returnObject);
  } catch (error) {
    log.monitoring.error('Error in serverStats', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to retrieve server statistics',
      details: error.message,
    });
  }
};
