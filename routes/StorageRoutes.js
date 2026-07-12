import { verifyApiKey } from '../middleware/VerifyApiKey.js';
import {
  getARCConfig,
  updateARCConfig,
  validateARCConfig,
  resetARCConfig,
} from '../controllers/ARCConfigController/index.js';
import {
  listDatasets,
  getDatasetDetails,
  createDataset,
  destroyDataset,
  setDatasetProperties,
  cloneDataset,
  promoteDataset,
  renameDataset,
  createSnapshot,
  destroySnapshot,
  rollbackSnapshot,
  holdSnapshot,
  releaseSnapshot,
  listHolds,
} from '../controllers/ZFSDatasetController/index.js';
import {
  listPools,
  getPoolDetails,
  getPoolStatus,
  createPool,
  destroyPool,
  setPoolProperties,
  addVdev,
  removeVdev,
  replaceDevice,
  onlineDevice,
  offlineDevice,
  scrubPool,
  stopScrub,
  exportPool,
  importPool,
  listImportablePools,
  upgradePool,
} from '../controllers/ZPoolController/index.js';
import {
  listSources,
  listRemoteTemplates,
  getRemoteTemplateDetails,
  listLocalTemplates,
  getLocalTemplate,
  downloadTemplate,
  deleteLocalTemplate,
  publishTemplate,
  exportTemplate,
  moveTemplate,
} from '../controllers/TemplateController.js';
import {
  listStoragePaths,
  createStoragePath,
  updateStoragePath,
  deleteStoragePath,
  listArtifacts,
  listISOArtifacts,
  listImageArtifacts,
  getArtifactDetails,
  downloadFromUrl,
  prepareArtifactUpload,
  uploadArtifactToTask,
  downloadArtifact,
  scanArtifacts,
  deleteArtifacts,
  getArtifactStats,
  getArtifactServiceStatus,
  moveArtifact,
  copyArtifact,
} from '../controllers/ArtifactController/index.js';
import {
  browseDirectory,
  createFolder,
  uploadFile,
  downloadFile,
  readFile,
  writeFile,
  moveFileItem,
  copyFileItem,
  renameItem,
  deleteFileItem,
  createArchiveTask,
  extractArchiveTask,
  changePermissions,
} from '../controllers/FileSystemController/index.js';
import {
  uploadSingle,
  validateUploadRequest,
  handleUploadError,
} from '../middleware/FileUpload.js';

/**
 * @fileoverview Storage routes — ZFS ARC config, datasets/snapshots, pools,
 * templates, artifact storage, and the file browser.
 */

/**
 * Register the ZFS routes (ARC config, datasets, snapshots, pools).
 * @param {import('express').Router} router - Application router
 */
const registerZfsRoutes = router => {
  // ZFS ARC Management Routes
  router.get('/system/zfs/arc/config', verifyApiKey, getARCConfig); // Get ZFS ARC configuration and tunables
  router.put('/system/zfs/arc/config', verifyApiKey, updateARCConfig); // Update ZFS ARC settings
  router.post('/system/zfs/arc/validate', verifyApiKey, validateARCConfig); // Validate ZFS ARC configuration
  router.post('/system/zfs/arc/reset', verifyApiKey, resetARCConfig); // Reset ZFS ARC to defaults

  // ZFS Dataset Management Routes
  router.get('/storage/datasets', verifyApiKey, listDatasets); // List ZFS datasets
  router.get('/storage/datasets/:name', verifyApiKey, getDatasetDetails); // Get dataset details
  router.post('/storage/datasets', verifyApiKey, createDataset); // Create dataset
  router.delete('/storage/datasets/:name', verifyApiKey, destroyDataset); // Delete dataset
  router.put('/storage/datasets/:name/properties', verifyApiKey, setDatasetProperties); // Set dataset properties
  router.post('/storage/datasets/:name/clone', verifyApiKey, cloneDataset); // Clone dataset from snapshot
  router.post('/storage/datasets/:name/promote', verifyApiKey, promoteDataset); // Promote clone to independent dataset
  router.post('/storage/datasets/:name/rename', verifyApiKey, renameDataset); // Rename dataset

  // ZFS Snapshot Management Routes
  router.post('/storage/datasets/:name/snapshots', verifyApiKey, createSnapshot); // Create snapshot
  router.delete('/storage/snapshots/:snapshot', verifyApiKey, destroySnapshot); // Delete snapshot
  router.post('/storage/snapshots/:snapshot/rollback', verifyApiKey, rollbackSnapshot); // Rollback to snapshot
  router.post('/storage/snapshots/:snapshot/holds', verifyApiKey, holdSnapshot); // Hold snapshot
  router.delete('/storage/snapshots/:snapshot/holds/:tag', verifyApiKey, releaseSnapshot); // Release snapshot hold
  router.get('/storage/snapshots/:snapshot/holds', verifyApiKey, listHolds); // List snapshot holds

  // ZFS Pool Management Routes
  router.get('/storage/pools', verifyApiKey, listPools); // List ZFS pools
  router.get('/storage/pools/importable', verifyApiKey, listImportablePools); // List importable pools
  router.post('/storage/pools/import', verifyApiKey, importPool); // Import pool
  router.get('/storage/pools/:pool', verifyApiKey, getPoolDetails); // Get pool details
  router.get('/storage/pools/:pool/status', verifyApiKey, getPoolStatus); // Get pool status
  router.post('/storage/pools', verifyApiKey, createPool); // Create pool
  router.delete('/storage/pools/:pool', verifyApiKey, destroyPool); // Destroy pool
  router.put('/storage/pools/:pool/properties', verifyApiKey, setPoolProperties); // Set pool properties
  router.post('/storage/pools/:pool/vdevs', verifyApiKey, addVdev); // Add vdev to pool
  router.post('/storage/pools/:pool/vdevs/remove', verifyApiKey, removeVdev); // Remove vdev from pool
  router.post('/storage/pools/:pool/devices/replace', verifyApiKey, replaceDevice); // Replace device in pool
  router.post('/storage/pools/:pool/devices/online', verifyApiKey, onlineDevice); // Online device in pool
  router.post('/storage/pools/:pool/devices/offline', verifyApiKey, offlineDevice); // Offline device in pool
  router.post('/storage/pools/:pool/scrub', verifyApiKey, scrubPool); // Start pool scrub
  router.post('/storage/pools/:pool/scrub/stop', verifyApiKey, stopScrub); // Stop pool scrub
  router.post('/storage/pools/:pool/export', verifyApiKey, exportPool); // Export pool
  router.post('/storage/pools/:pool/upgrade', verifyApiKey, upgradePool); // Upgrade pool
};

/**
 * Register the template and artifact storage routes.
 * @param {import('express').Router} router - Application router
 */
const registerTemplateArtifactRoutes = router => {
  // Template Management Routes — bare /templates wire (D14, the Go agent's
  // exact paths). Literal paths MUST register before the :templateId wildcards
  // or POST /templates/pull would be eaten as templateId="pull".
  router.get('/templates/sources', verifyApiKey, listSources);
  router.get('/templates/remote/:sourceName', verifyApiKey, listRemoteTemplates);
  router.get('/templates/remote/:sourceName/:org/:boxName', verifyApiKey, getRemoteTemplateDetails);
  router.post('/templates/pull', verifyApiKey, downloadTemplate);
  router.post('/templates/publish', verifyApiKey, publishTemplate);
  router.post('/templates/export', verifyApiKey, exportTemplate);
  router.get('/templates', verifyApiKey, listLocalTemplates);
  router.get('/templates/:templateId', verifyApiKey, getLocalTemplate);
  router.delete('/templates/:templateId', verifyApiKey, deleteLocalTemplate);
  router.post('/templates/:templateId/move', verifyApiKey, moveTemplate);

  // Artifact Storage Management Routes
  router.get('/artifacts/storage/paths', verifyApiKey, listStoragePaths); // List storage paths
  router.post('/artifacts/storage/paths', verifyApiKey, createStoragePath); // Create storage path
  router.put('/artifacts/storage/paths/:id', verifyApiKey, updateStoragePath); // Update storage path
  router.delete('/artifacts/storage/paths/:id', verifyApiKey, deleteStoragePath); // Delete storage path
  router.get('/artifacts', verifyApiKey, listArtifacts); // List all artifacts
  router.get('/artifacts/iso', verifyApiKey, listISOArtifacts); // List ISO artifacts
  router.get('/artifacts/image', verifyApiKey, listImageArtifacts); // List image artifacts
  // Specific single-segment routes MUST register before /artifacts/:id —
  // stats was shadowed by :id (matched as id="stats") until this ordering fix
  router.get('/artifacts/stats', verifyApiKey, getArtifactStats); // Get artifact statistics
  router.get('/artifacts/service/status', verifyApiKey, getArtifactServiceStatus); // Get service status
  router.get('/artifacts/:id', verifyApiKey, getArtifactDetails); // Get artifact details
  router.post('/artifacts/:id/move', verifyApiKey, moveArtifact); // Move artifact to another storage location
  router.post('/artifacts/:id/copy', verifyApiKey, copyArtifact); // Copy artifact to another storage location
  router.post('/artifacts/download', verifyApiKey, downloadFromUrl); // Download artifact from URL (async task)
  router.post('/artifacts/upload/prepare', verifyApiKey, prepareArtifactUpload); // Prepare upload (returns task_id and upload_url)
  router.post(
    '/artifacts/upload/:taskId',
    verifyApiKey,
    validateUploadRequest,
    uploadArtifactToTask,
    handleUploadError
  ); // Upload artifact file to prepared task
  router.get('/artifacts/:id/download', verifyApiKey, downloadArtifact); // Stream download artifact file
  router.post('/artifacts/scan', verifyApiKey, scanArtifacts); // Scan storage locations (async task)
  router.delete('/artifacts/files', verifyApiKey, deleteArtifacts); // Delete artifact files (async task)
};

/**
 * Register the file browser routes.
 * @param {import('express').Router} router - Application router
 */
const registerFilesystemRoutes = router => {
  // File System Management Routes
  router.get('/filesystem', verifyApiKey, browseDirectory); // Browse directory contents
  router.post('/filesystem/folder', verifyApiKey, createFolder); // Create directory
  router.post(
    '/filesystem/upload',
    verifyApiKey,
    validateUploadRequest,
    uploadSingle('file'),
    uploadFile,
    handleUploadError
  ); // Upload file
  router.get('/filesystem/download', verifyApiKey, downloadFile); // Download file
  router.get('/filesystem/content', verifyApiKey, readFile); // Read text file content
  router.put('/filesystem/content', verifyApiKey, writeFile); // Write text file content
  router.put('/filesystem/move', verifyApiKey, moveFileItem); // Move/rename item (async task)
  router.post('/filesystem/copy', verifyApiKey, copyFileItem); // Copy item (async task)
  router.patch('/filesystem/rename', verifyApiKey, renameItem); // Rename item
  router.delete('/filesystem', verifyApiKey, deleteFileItem); // Delete item
  router.patch('/filesystem/permissions', verifyApiKey, changePermissions); // Change file/directory permissions
  router.post('/filesystem/archive/create', verifyApiKey, createArchiveTask); // Create archive (async task)
  router.post('/filesystem/archive/extract', verifyApiKey, extractArchiveTask); // Extract archive (async task)
};

/**
 * Register the storage, template, artifact, and filesystem route set on the
 * shared router.
 * @param {import('express').Router} router - Application router
 */
export const registerStorageRoutes = router => {
  registerZfsRoutes(router);
  registerTemplateArtifactRoutes(router);
  registerFilesystemRoutes(router);
};
