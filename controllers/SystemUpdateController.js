/**
 * @fileoverview System Update Controller — aggregating index
 * @description Handles system update operations via pkg update commands. The
 * implementation lives in ./SystemUpdate/ (Query vs Task creation); this index
 * preserves the module's import path.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

export { checkForUpdates, getUpdateHistory } from './SystemUpdate/SystemUpdateQueryController.js';
export { installUpdates, refreshMetadata } from './SystemUpdate/SystemUpdateTaskController.js';
