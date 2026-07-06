/**
 * @fileoverview System Logs Controller — aggregating index
 * @description Provides API endpoints for viewing system and application logs.
 * The implementation lives in ./SystemLogs/ (log file endpoints, fault manager
 * endpoints, shared utilities); this index preserves the module's import path.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { listLogFiles, getLogFile } from './SystemLogs/LogFileController.js';
import { getFaultManagerLogs } from './SystemLogs/FaultManagerLogController.js';

export { listLogFiles, getLogFile, getFaultManagerLogs };

export default {
  listLogFiles,
  getLogFile,
  getFaultManagerLogs,
};
