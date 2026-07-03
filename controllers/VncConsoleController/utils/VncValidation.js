/**
 * @fileoverview VNC Validation Utilities
 * @description Zone validation, port management, and VNC configuration validation with performance optimizations
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import net from 'net';
import { spawn } from 'child_process';
import VncSessions from '../../../models/VncSessionModel.js';
import { log } from '../../../lib/Logger.js';
import config from '../../../config/ConfigLoader.js';
import { validateZoneName } from '../../../lib/ZoneValidation.js';

/**
 * Get VNC port range from configuration
 * @returns {Object} Port range configuration
 */
const getVncPortRange = () => {
  const vncConfig = config.getVnc();
  return {
    start: vncConfig.web_port_range_start || 8000,
    end: vncConfig.web_port_range_end || 8100,
  };
};

/**
 * VNC port range configuration
 * Using configured range to avoid browser port restrictions
 */
export const VNC_PORT_RANGE = getVncPortRange();

/**
 * Get VNC session timeout from configuration (in milliseconds)
 * @returns {number} Session timeout in milliseconds
 */
const getVncSessionTimeout = () => {
  const vncConfig = config.getVnc();
  return (vncConfig.session_timeout || 1800) * 1000; // Convert seconds to milliseconds
};

/**
 * VNC session timeout from configuration
 */
export const VNC_SESSION_TIMEOUT = getVncSessionTimeout();

// Note: validateZoneName is imported from lib/ZoneValidation.js and re-exported for backwards compatibility
export { validateZoneName };

/**
 * Check if port is available using multiple methods (restored original working logic)
 * @param {number} port - Port to check
 * @returns {Promise<boolean>} True if port is available
 */
export const isPortAvailable = async port => {
  // Method 1: Check for existing zadm processes using this port (original ps auxww approach)
  const isPortInUseByZadm = await new Promise(resolve => {
    const ps = spawn('ps', ['auxww'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';

    ps.stdout.on('data', data => {
      output += data.toString();
    });

    ps.on('exit', () => {
      const lines = output.split('\n');
      const zadmProcesses = lines.filter(
        line => line.includes('zadm vnc') && line.includes(`-w 0.0.0.0:${port} `)
      );

      if (zadmProcesses.length > 0) {
        log.websocket.debug('Port is not available (zadm process found)', {
          port,
          processes: zadmProcesses.map(proc => proc.trim()),
        });
        resolve(true);
      } else {
        log.websocket.debug('No zadm processes found for port', { port });
        resolve(false);
      }
    });

    ps.on('error', () => {
      log.websocket.warn('Error checking for zadm processes', { port });
      resolve(false);
    });
  });

  if (isPortInUseByZadm) {
    return false;
  }

  // Method 2: Check database for existing sessions using this port
  try {
    const existingSession = await VncSessions.findOne({
      where: { web_port: port, status: 'active' },
    });

    if (existingSession) {
      log.websocket.debug('Port is not available (active VNC session in database)', { port });
      return false;
    }
  } catch (dbError) {
    log.websocket.warn('Failed to check database for port', {
      port,
      error: dbError.message,
    });
  }

  // Method 3: Try to bind to the port
  return new Promise(resolve => {
    const server = net.createServer();

    const handleSuccess = () => {
      server.once('close', () => {
        log.websocket.debug('Port is available', { port });
        resolve(true);
      });
      server.close();
    };

    const handleError = () => {
      log.websocket.debug('Port is not available (bind test failed)', { port });
      resolve(false);
    };

    server.listen(port, handleSuccess);
    server.on('error', handleError);
  });
};

/**
 * Find an available port in the VNC range (optimized to avoid await-in-loop)
 * @returns {Promise<number>} Available port number
 */
export const findAvailablePort = () =>
  // Use recursive approach to avoid await-in-loop performance issues
  new Promise((resolve, reject) => {
    let currentPort = VNC_PORT_RANGE.start;

    const checkNextPort = async () => {
      if (currentPort > VNC_PORT_RANGE.end) {
        reject(new Error('No available ports in VNC range'));
        return;
      }

      try {
        const available = await isPortAvailable(currentPort);
        if (available) {
          log.websocket.debug('Found available port', { port: currentPort });
          resolve(currentPort);
          return;
        }

        currentPort++;
        // Use setImmediate to avoid blocking the event loop
        setImmediate(checkNextPort);
      } catch (error) {
        reject(error);
      }
    };

    // Start checking from the first port
    checkNextPort();
  });

/**
 * Validate static port for zone VNC session
 * Checks port range, OS availability, and cross-zone conflicts
 * @param {number} port - Port to validate
 * @param {string} zoneName - Zone name requesting the port
 * @returns {Promise<{available: boolean, reason?: string}>}
 */
export const validateStaticPort = async (port, zoneName) => {
  const { Op } = await import('sequelize');

  // Range validation (unprivileged ports recommended)
  if (port < 1025) {
    return {
      available: false,
      reason: `Port ${port} requires root privileges (<1025). Use ports ≥1025.`,
    };
  }

  if (port > 65535) {
    return {
      available: false,
      reason: `Port ${port} exceeds maximum (65535)`,
    };
  }

  // Check other zones (active or stopped)
  const otherZone = await VncSessions.findOne({
    where: {
      web_port: port,
      zone_name: { [Op.ne]: zoneName },
    },
  });

  if (otherZone) {
    return {
      available: false,
      reason: `Port ${port} already allocated to zone ${otherZone.zone_name}`,
    };
  }

  // OS-level availability test (reuse existing bind test)
  const osAvailable = await isPortAvailable(port);
  if (!osAvailable) {
    return {
      available: false,
      reason: `Port ${port} in use by system process`,
    };
  }

  return { available: true };
};

/**
 * Test if VNC web server is responding using Promise-based approach (optimized for performance)
 * @param {number} port - Port to test
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<boolean>} True if server is responding
 */
export const testVncConnection = (port, maxRetries = 10) =>
  // Create a single promise that handles all retry logic internally to avoid await-in-loop
  new Promise(resolve => {
    let attempt = 0;

    const tryConnection = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.status === 200) {
          log.websocket.debug('VNC connection test successful', { port, attempt });
          resolve(true);
          return;
        }
      } catch {
        // Connection not ready yet, continue to next attempt
      }

      attempt++;
      if (attempt >= maxRetries) {
        log.websocket.debug('VNC connection test failed after all retries', { port, maxRetries });
        resolve(false);
        return;
      }

      // Schedule next attempt with setTimeout (no await needed)
      setTimeout(tryConnection, 500);
    };

    // Start the first attempt
    tryConnection();
  });
