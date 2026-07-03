/**
 * @fileoverview VNC Connection Tracker Utilities
 * @description WebSocket connection tracking for smart cleanup (based on TerminalSession patterns)
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { log } from '../../../lib/Logger.js';

/**
 * WebSocket connection tracking for smart cleanup (similar to TerminalSession pattern)
 */
class VncConnectionTracker {
  constructor() {
    this.connections = new Map(); // zoneName -> Set of connection IDs
  }

  /**
   * Add a client connection for a zone
   * @param {string} zoneName - Zone name
   * @param {string} connectionId - Unique connection ID
   */
  addConnection(zoneName, connectionId) {
    if (!this.connections.has(zoneName)) {
      this.connections.set(zoneName, new Set());
    }
    this.connections.get(zoneName).add(connectionId);
    log.websocket.debug('VNC client connection added', {
      zone_name: zoneName,
      connection_id: connectionId,
      total_connections: this.connections.get(zoneName).size,
    });
  }

  /**
   * Remove a client connection for a zone
   * @param {string} zoneName - Zone name
   * @param {string} connectionId - Unique connection ID
   * @returns {boolean} - True if this was the last connection
   */
  removeConnection(zoneName, connectionId) {
    if (!this.connections.has(zoneName)) {
      return false;
    }

    const zoneConnections = this.connections.get(zoneName);
    zoneConnections.delete(connectionId);

    const remainingConnections = zoneConnections.size;
    log.websocket.debug('VNC client connection removed', {
      zone_name: zoneName,
      connection_id: connectionId,
      remaining_connections: remainingConnections,
    });

    if (remainingConnections === 0) {
      this.connections.delete(zoneName);
      log.websocket.info('Last VNC client disconnected', {
        zone_name: zoneName,
        eligible_for_cleanup: true,
      });
      return true;
    }

    return false;
  }

  /**
   * Get connection count for a zone
   * @param {string} zoneName - Zone name
   * @returns {number} - Number of active connections
   */
  getConnectionCount(zoneName) {
    return this.connections.has(zoneName) ? this.connections.get(zoneName).size : 0;
  }

  /**
   * Get all zones with active connections
   * @returns {Array<string>} - Array of zone names
   */
  getActiveZones() {
    return Array.from(this.connections.keys());
  }
}

/**
 * Create and export singleton connection tracker
 */
export const connectionTracker = new VncConnectionTracker();
