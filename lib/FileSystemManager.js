/**
 * @fileoverview File System Manager for Zoneweaver Agent — aggregating index
 * @description Provides secure filesystem operations for the file browser functionality.
 * The implementation lives in ./filesystem/ (core helpers, browse/read operations,
 * mutation operations, archive operations); this index preserves the module's import path.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

export {
  getMimeType,
  executeCommand,
  validatePath,
  isBinaryFile,
} from './filesystem/FileSystemCore.js';
export { getItemInfo, listDirectory, readFileContent } from './filesystem/FileSystemBrowse.js';
export {
  writeFileContent,
  createDirectory,
  deleteItem,
  moveItem,
  copyItem,
} from './filesystem/FileSystemMutate.js';
export { createArchive, extractArchive } from './filesystem/FileSystemArchive.js';
