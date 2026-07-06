/**
 * @fileoverview Graceful shutdown coordinator for Zoneweaver Agent
 * @description Handles SIGTERM/SIGINT by stopping background work producers,
 *   closing the HTTP, HTTPS and WebSocket servers, and closing the database
 *   connection cleanly (flushing the SQLite WAL) before exiting.
 *
 *   Under SMF the stop method is the `:kill` token, which sends SIGTERM to every
 *   process in the service contract (node plus any `zadm vnc`, `zlogin -C` or
 *   host-shell PTY children), so those children are reaped by the OS in ~1s.
 *   This handler is responsible only for the node process's own resources; a
 *   watchdog guarantees the process exits even if a close step stalls, so it can
 *   never hang `svcadm disable`.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { log } from './Logger.js';
import { allDatabases } from '../config/Database.js';
import { stopTaskProcessor } from '../controllers/TaskQueue/index.js';
import { stopArtifactStorage } from '../controllers/ArtifactStorageService.js';
import { stopHostMonitoring } from '../controllers/HostMonitoringService.js';

/**
 * Hard-exit deadline (ms). If graceful cleanup has not finished by this point the
 * process exits anyway. Normal cleanup completes in well under a second; this cap
 * sits far under the SMF stop method timeout so a stalled close (e.g. a wedged DB
 * query) can never keep the process — and thus the service contract — alive long
 * enough to slow `svcadm disable`. The SQLite WAL is crash-safe, so exiting before
 * a clean checkpoint loses nothing but the checkpoint itself.
 */
const SHUTDOWN_GRACE_MS = 5000;

/** Guard so a second signal during shutdown does not re-run the sequence. */
let shuttingDown = false;

/**
 * Close a Node HTTP/HTTPS server promptly.
 * @description Resolves once the server stops accepting connections. Existing
 *   keep-alive/WebSocket sockets are force-closed so `close()` completes quickly
 *   rather than waiting out idle connection timeouts.
 * @param {import('http').Server|import('https').Server|null} server - Server to close
 * @returns {Promise<void>}
 */
const closeServer = server =>
  new Promise(resolve => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    // Node >=18.2: drop lingering connections so close() does not block on them.
    server.closeAllConnections?.();
  });

/**
 * Perform the graceful shutdown sequence exactly once.
 * @param {string} signal - The signal that triggered shutdown
 * @param {Object} servers - Long-lived server handles to close
 * @param {import('http').Server} servers.httpServer - The HTTP server
 * @param {import('https').Server|null} servers.httpsServer - The HTTPS server (null if SSL disabled)
 * @param {import('ws').WebSocketServer} servers.wss - The WebSocket server
 * @returns {Promise<void>}
 */
const shutdown = async (signal, { httpServer, httpsServer, wss }) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  log.app.info('Graceful shutdown initiated', { signal });

  // Safety net: never let a stalled close hang the SMF stop method.
  const watchdog = setTimeout(() => {
    log.app.warn('Graceful shutdown exceeded grace period - forcing exit', {
      grace_ms: SHUTDOWN_GRACE_MS,
    });
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  watchdog.unref();

  try {
    // 1. Stop producing new work (new tasks, periodic scans, discovery).
    stopTaskProcessor();
    stopArtifactStorage();
    stopHostMonitoring();

    // 2. Stop accepting connections. Terminate live WebSocket clients so their
    //    backend sockets (VNC proxy, PTY streams) tear down too.
    if (wss) {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          // Client may already be closing.
        }
      }
      wss.close();
    }

    await Promise.allSettled([closeServer(httpServer), closeServer(httpsServer)]);

    // 3. Close the databases last so in-flight queries can settle and each
    //    SQLite WAL is checkpointed on a clean connection close. Non-SQLite
    //    dialects share one instance across the domain handles — close each
    //    underlying instance exactly once.
    const closed = new Set();
    await Promise.allSettled(
      allDatabases
        .filter(({ instance }) => (closed.has(instance) ? false : closed.add(instance)))
        .map(({ instance }) => instance.close())
    );

    log.app.info('Graceful shutdown complete', { signal });
  } catch (error) {
    log.app.error('Error during graceful shutdown', {
      signal,
      error: error.message,
      stack: error.stack,
    });
  } finally {
    clearTimeout(watchdog);
    process.exit(0);
  }
};

/**
 * Install SIGTERM/SIGINT handlers that gracefully shut the agent down.
 * @param {Object} servers - Long-lived server handles to close on shutdown
 * @param {import('http').Server} servers.httpServer - The HTTP server
 * @param {import('https').Server|null} servers.httpsServer - The HTTPS server (null if SSL disabled)
 * @param {import('ws').WebSocketServer} servers.wss - The WebSocket server
 * @returns {void}
 */
export const installShutdownHandlers = servers => {
  ['SIGTERM', 'SIGINT'].forEach(signal => {
    process.on(signal, () => {
      shutdown(signal, servers).catch(error => {
        log.app.error('Unhandled error in shutdown handler', {
          signal,
          error: error.message,
        });
        process.exit(1);
      });
    });
  });

  log.app.debug('Shutdown handlers installed', { signals: ['SIGTERM', 'SIGINT'] });
};
