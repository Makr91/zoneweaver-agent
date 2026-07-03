/**
 * @fileoverview VNC Console Controller Index
 * @description Main entry point for VNC console controllers
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

// Import session management functions
import { startVncSession, getVncSessionInfo, stopVncSession } from './SessionController.js';

// Import management functions
import { listVncSessions } from './ManagementController.js';

// Import screenshot function
import { getVncScreenshot } from './ScreenshotController.js';

// Import cleanup service
import { startVncSessionCleanup, isVncEnabledAtBoot } from './utils/VncCleanupService.js';

// Import utilities for WebSocket handler
import { sessionManager } from './utils/VncSessionManager.js';
import { connectionTracker } from './utils/VncConnectionTracker.js';

import { log } from '../../lib/Logger.js';

/**
 * Smart cleanup logic - only cleanup VNC sessions when appropriate
 * @param {string} zoneName - Zone name
 * @param {boolean} isLastClient - Whether this was the last client to disconnect
 */
export const performSmartCleanup = async (zoneName, isLastClient) => {
  if (!isLastClient) {
    log.websocket.debug('Other clients still connected - no cleanup needed', {
      zone_name: zoneName,
    });
    return;
  }

  log.websocket.debug('Last client disconnected - checking cleanup eligibility', {
    zone_name: zoneName,
  });

  // Check if zone has VNC enabled at boot
  const vncEnabledAtBoot = await isVncEnabledAtBoot(zoneName);

  if (vncEnabledAtBoot) {
    log.websocket.info('Zone has VNC enabled at boot - keeping session alive', {
      zone_name: zoneName,
    });
    return; // Don't cleanup - keep the session running
  }

  log.websocket.info('Zone does NOT have VNC enabled at boot - performing cleanup after delay', {
    zone_name: zoneName,
  });

  // Wait 10 minutes before cleanup to allow reasonable re-access while still freeing resources
  setTimeout(
    async () => {
      // Double-check that no new clients have connected in the meantime
      const currentConnections = connectionTracker.getConnectionCount(zoneName);

      if (currentConnections === 0) {
        log.websocket.info('Performing smart cleanup - no boot VNC and no active clients', {
          zone_name: zoneName,
        });

        const killed = await sessionManager.killSession(zoneName);

        if (killed) {
          // Update database
          try {
            const VncSessions = (await import('../../models/VncSessionModel.js')).default;
            await VncSessions.update(
              { status: 'stopped' },
              { where: { zone_name: zoneName, status: 'active' } }
            );
            log.websocket.info('Smart cleanup completed', { zone_name: zoneName });
          } catch (dbError) {
            log.websocket.warn('Failed to update database during cleanup', {
              zone_name: zoneName,
              error: dbError.message,
            });
          }
        }
      } else {
        log.websocket.info('New clients connected during cleanup delay - canceling cleanup', {
          zone_name: zoneName,
        });
      }
    },
    10 * 60 * 1000
  ); // 10 minute delay for reasonable re-access
};

export {
  // Session management
  startVncSession,
  getVncSessionInfo,
  stopVncSession,

  // Management functions
  listVncSessions,

  // Screenshot
  getVncScreenshot,

  // Cleanup service
  startVncSessionCleanup,
};

// Default export
export default {
  startVncSession,
  getVncSessionInfo,
  stopVncSession,
  listVncSessions,
  getVncScreenshot,
  startVncSessionCleanup,
};
