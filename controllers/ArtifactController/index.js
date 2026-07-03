/**
 * @fileoverview Main Artifact Controller Entry Point
 * @description Central export point for all artifact management functionality
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

// Storage Path Management
export {
  listStoragePaths,
  createStoragePath,
  updateStoragePath,
  deleteStoragePath,
} from './StoragePathController.js';

// Artifact Listing and Details
export {
  listArtifacts,
  listISOArtifacts,
  listImageArtifacts,
  getArtifactDetails,
} from './ArtifactListController.js';

// Upload Operations
export { prepareArtifactUpload, uploadArtifactToTask } from './UploadController.js';

// Download Operations
export { downloadFromUrl, downloadArtifact } from './DownloadController.js';

// Scanning Operations
export { scanArtifacts } from './ScanController.js';

// File Operations (Move, Copy, Delete)
export { moveArtifact, copyArtifact, deleteArtifacts } from './FileOperationsController.js';

// Statistics and Service Status
export { getArtifactStats, getArtifactServiceStatus } from './StatsController.js';
