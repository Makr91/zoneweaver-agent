/**
 * @fileoverview Terminal Session Controller for Zoneweaver Agent — aggregating index
 * @description Manages the lifecycle of pseudo-terminal sessions. The implementation
 * lives in ./TerminalSession/ (REST session lifecycle, shared PTY helpers); this index
 * preserves the module's import path.
 */

export {
  startTerminalSession,
  checkSessionHealth,
  getTerminalSessionInfo,
  stopTerminalSession,
  listTerminalSessions,
} from './TerminalSession/SessionLifecycleController.js';
export { getPtyProcess } from './TerminalSession/utils/SessionHelpers.js';
