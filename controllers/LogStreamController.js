/**
 * @fileoverview Log Stream Controller — aggregating index
 * @description WebSocket streaming for real-time log file monitoring. The
 * implementation lives in ./LogStream/ (REST session lifecycle, WS socket
 * handling, shared helpers); this index preserves the module's import path.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import {
  startLogStream,
  listLogStreamSessions,
  stopLogStream,
  getLogStreamInfo,
  cleanupLogStreamSessions,
} from './LogStream/StreamSessionController.js';
import {
  handleLogStreamConnection,
  handleLogStreamUpgrade,
} from './LogStream/StreamSocketController.js';

export {
  startLogStream,
  listLogStreamSessions,
  stopLogStream,
  getLogStreamInfo,
  cleanupLogStreamSessions,
  handleLogStreamConnection,
  handleLogStreamUpgrade,
};

export default {
  startLogStream,
  listLogStreamSessions,
  stopLogStream,
  getLogStreamInfo,
  handleLogStreamUpgrade,
  handleLogStreamConnection,
  cleanupLogStreamSessions,
};
