/**
 * @fileoverview SSH Terminal Controller for Zoneweaver Agent — aggregating index
 * @description Manages interactive SSH terminal sessions to zones via WebSocket.
 *              Uses ssh2 library for SSH connections piped through WebSocket to xterm.js frontend.
 *              The implementation lives in ./SSHTerminal/ (REST session lifecycle, WS socket
 *              handling, shared helpers); this index preserves the module's import path.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

export {
  startSSHSession,
  getSSHSessionInfo,
  stopSSHSession,
  listSSHSessions,
  getSSHCleanupTask,
  startSSHSessionCleanup,
} from './SSHTerminal/SSHSessionController.js';
export { handleSSHConnection } from './SSHTerminal/SSHSocketController.js';
