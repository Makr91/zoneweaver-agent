import {
  executeCreateIPAddressTask,
  executeDeleteIPAddressTask,
  executeEnableIPAddressTask,
  executeDisableIPAddressTask,
} from '../TaskManager/NetworkManager.js';
import {
  executeCreateVNICTask,
  executeDeleteVNICTask,
  executeSetVNICPropertiesTask,
} from '../TaskManager/VNICManager.js';
import {
  executeCreateAggregateTask,
  executeDeleteAggregateTask,
  executeModifyAggregateLinksTask,
} from '../TaskManager/AggregateManager.js';
import {
  executeCreateEtherstubTask,
  executeDeleteEtherstubTask,
} from '../TaskManager/EtherstubManager.js';
import { executeCreateVlanTask, executeDeleteVlanTask } from '../TaskManager/VLANManager.js';
import {
  executeCreateBridgeTask,
  executeDeleteBridgeTask,
  executeModifyBridgeLinksTask,
} from '../TaskManager/BridgeManager.js';
import {
  executeCreateNatRuleTask,
  executeDeleteNatRuleTask,
  executeConfigureForwardingTask,
} from '../TaskManager/NatManager.js';
import {
  executeDhcpUpdateConfigTask,
  executeDhcpAddHostTask,
  executeDhcpRemoveHostTask,
  executeDhcpServiceControlTask,
} from '../TaskManager/DhcpManager.js';
import {
  executeCreateDatasetTask,
  executeDestroyDatasetTask,
  executeSetPropertiesTask,
  executeCloneDatasetTask,
  executePromoteDatasetTask,
  executeRenameDatasetTask,
  executeCreateSnapshotTask,
  executeDestroySnapshotTask,
  executeRollbackSnapshotTask,
  executeHoldSnapshotTask,
  executeReleaseSnapshotTask,
} from '../TaskManager/ZFSDatasetManager.js';
import {
  executeCreatePoolTask,
  executeDestroyPoolTask,
  executeSetPoolPropertiesTask,
  executeExportPoolTask,
  executeImportPoolTask,
  executeUpgradePoolTask,
} from '../TaskManager/ZPoolManager.js';
import {
  executeAddVdevTask,
  executeRemoveVdevTask,
  executeReplaceDeviceTask,
  executeOnlineDeviceTask,
  executeOfflineDeviceTask,
  executeScrubPoolTask,
  executeStopScrubTask,
} from '../TaskManager/ZPoolDeviceManager.js';
import {
  executeTemplateDownloadTask,
  executeTemplateDeleteTask,
  executeTemplatePublishTask,
  executeTemplateExportTask,
  executeTemplateMoveTask,
} from '../TaskManager/TemplateManager/index.js';
import {
  executeArtifactDownloadTask,
  executeArtifactScanAllTask,
  executeArtifactScanLocationTask,
  executeArtifactDeleteFileTask,
  executeArtifactDeleteFolderTask,
  executeArtifactUploadProcessTask,
  executeArtifactMoveTask,
  executeArtifactCopyTask,
} from '../TaskManager/ArtifactManager/index.js';

/**
 * @fileoverview Network, ZFS, ZPool, artifact, and template task dispatchers
 */

/**
 * Execute network-related tasks
 * @param {string} operation - Operation type
 * @param {string} metadata - Task metadata
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeNetworkTask = (operation, metadata) => {
  const taskMap = {
    create_ip_address: executeCreateIPAddressTask,
    delete_ip_address: executeDeleteIPAddressTask,
    enable_ip_address: executeEnableIPAddressTask,
    disable_ip_address: executeDisableIPAddressTask,
    create_vnic: executeCreateVNICTask,
    delete_vnic: executeDeleteVNICTask,
    set_vnic_properties: executeSetVNICPropertiesTask,
    create_aggregate: executeCreateAggregateTask,
    delete_aggregate: executeDeleteAggregateTask,
    modify_aggregate_links: executeModifyAggregateLinksTask,
    create_etherstub: executeCreateEtherstubTask,
    delete_etherstub: executeDeleteEtherstubTask,
    create_vlan: executeCreateVlanTask,
    delete_vlan: executeDeleteVlanTask,
    create_bridge: executeCreateBridgeTask,
    delete_bridge: executeDeleteBridgeTask,
    modify_bridge_links: executeModifyBridgeLinksTask,
    create_nat_rule: executeCreateNatRuleTask,
    delete_nat_rule: executeDeleteNatRuleTask,
    configure_forwarding: executeConfigureForwardingTask,
    dhcp_update_config: executeDhcpUpdateConfigTask,
    dhcp_add_host: executeDhcpAddHostTask,
    dhcp_remove_host: executeDhcpRemoveHostTask,
    dhcp_service_control: executeDhcpServiceControlTask,
  };

  const handler = taskMap[operation];
  if (handler) {
    return handler(metadata);
  }

  return { success: false, error: `Unknown network operation: ${operation}` };
};

/**
 * Execute ZFS dataset and snapshot tasks
 * @param {string} operation - Operation type
 * @param {string} metadata - Task metadata
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZFSTask = (operation, metadata) => {
  switch (operation) {
    case 'zfs_create_dataset':
      return executeCreateDatasetTask(metadata);
    case 'zfs_destroy_dataset':
      return executeDestroyDatasetTask(metadata);
    case 'zfs_set_properties':
      return executeSetPropertiesTask(metadata);
    case 'zfs_clone_dataset':
      return executeCloneDatasetTask(metadata);
    case 'zfs_promote_dataset':
      return executePromoteDatasetTask(metadata);
    case 'zfs_rename_dataset':
      return executeRenameDatasetTask(metadata);
    case 'zfs_create_snapshot':
      return executeCreateSnapshotTask(metadata);
    case 'zfs_destroy_snapshot':
      return executeDestroySnapshotTask(metadata);
    case 'zfs_rollback_snapshot':
      return executeRollbackSnapshotTask(metadata);
    case 'zfs_hold_snapshot':
      return executeHoldSnapshotTask(metadata);
    case 'zfs_release_snapshot':
      return executeReleaseSnapshotTask(metadata);
    default:
      return { success: false, error: `Unknown ZFS operation: ${operation}` };
  }
};

/**
 * Execute ZFS pool management tasks
 * @param {string} operation - Operation type
 * @param {string} metadata - Task metadata
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZPoolTask = (operation, metadata) => {
  switch (operation) {
    case 'zpool_create':
      return executeCreatePoolTask(metadata);
    case 'zpool_destroy':
      return executeDestroyPoolTask(metadata);
    case 'zpool_set_properties':
      return executeSetPoolPropertiesTask(metadata);
    case 'zpool_add_vdev':
      return executeAddVdevTask(metadata);
    case 'zpool_remove_vdev':
      return executeRemoveVdevTask(metadata);
    case 'zpool_replace_device':
      return executeReplaceDeviceTask(metadata);
    case 'zpool_online_device':
      return executeOnlineDeviceTask(metadata);
    case 'zpool_offline_device':
      return executeOfflineDeviceTask(metadata);
    case 'zpool_scrub':
      return executeScrubPoolTask(metadata);
    case 'zpool_stop_scrub':
      return executeStopScrubTask(metadata);
    case 'zpool_export':
      return executeExportPoolTask(metadata);
    case 'zpool_import':
      return executeImportPoolTask(metadata);
    case 'zpool_upgrade':
      return executeUpgradePoolTask(metadata);
    default:
      return { success: false, error: `Unknown ZPool operation: ${operation}` };
  }
};

/**
 * Execute artifact-related tasks
 * @param {string} operation - Operation type
 * @param {string} metadata - Task metadata
 * @param {Object} task - The task row itself — progress-updating executors
 *   write it directly (no self-lookup guessing)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeArtifactTask = (operation, metadata, task) => {
  switch (operation) {
    case 'artifact_download_url':
      return executeArtifactDownloadTask(metadata, task);
    case 'artifact_scan_all':
      return executeArtifactScanAllTask(metadata);
    case 'artifact_scan_location':
      return executeArtifactScanLocationTask(metadata);
    case 'artifact_delete_file':
      return executeArtifactDeleteFileTask(metadata);
    case 'artifact_delete_folder':
      return executeArtifactDeleteFolderTask(metadata);
    case 'artifact_upload':
      return executeArtifactUploadProcessTask(metadata, task);
    case 'artifact_move':
      return executeArtifactMoveTask(metadata, task);
    case 'artifact_copy':
      return executeArtifactCopyTask(metadata, task);
    default:
      return { success: false, error: `Unknown artifact operation: ${operation}` };
  }
};

/**
 * Execute template-related tasks
 * @param {string} operation - Operation type
 * @param {string} metadata - Task metadata
 * @param {Object} task - The task row itself — progress-updating executors
 *   write it directly (no self-lookup guessing)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeTemplateTask = (operation, metadata, task) => {
  switch (operation) {
    case 'template_download':
      return executeTemplateDownloadTask(metadata, task);
    case 'template_delete':
      return executeTemplateDeleteTask(metadata);
    case 'template_upload':
      return executeTemplatePublishTask(metadata, task);
    case 'template_export':
      return executeTemplateExportTask(metadata, task);
    case 'template_move':
      return executeTemplateMoveTask(metadata, task);
    default:
      return { success: false, error: `Unknown template operation: ${operation}` };
  }
};
