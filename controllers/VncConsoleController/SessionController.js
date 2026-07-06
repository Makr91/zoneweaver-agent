/**
 * @fileoverview VNC Session Controller — aggregating index
 * @description Handles VNC session start, stop, and info operations using existing utilities.
 * The implementation lives in ./SessionStartController.js (session start/spawn) and
 * ./SessionInfoController.js (info retrieval and stop); this index preserves the
 * module's import path.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

export { startVncSession } from './SessionStartController.js';
export { getVncSessionInfo, stopVncSession } from './SessionInfoController.js';
