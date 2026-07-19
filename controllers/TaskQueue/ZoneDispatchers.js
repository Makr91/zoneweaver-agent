import {
  executeStartTask,
  executeStopTask,
  executeRestartTask,
  executeResetTask,
  executeSuspendTask,
  executeResumeTask,
  executeDeleteTask,
  executeDiscoverTask,
} from '../TaskManager/ZoneManager.js';
import {
  executeZoneAttachTask,
  executeZoneDetachTask,
  executeZoneMoveTask,
} from '../TaskManager/Zone/ZoneAdminTasks.js';
import {
  enableService,
  disableService,
  restartService,
  refreshService,
} from '../../lib/ServiceManager.js';
import {
  executeZoneCreateStorageTask,
  executeZoneCreateConfigTask,
  executeZoneCreateInstallTask,
  executeZoneCreateFinalizeTask,
} from '../TaskManager/ZoneCreationManager/index.js';
import { executeZoneModifyTask } from '../TaskManager/ZoneModificationManager.js';
import { executeZoneSetupTask } from '../TaskManager/ZoneSetupManager.js';
import {
  executeZoneWaitSSHTask,
  executeZoneProvisioningExtractTask,
  executeZoneSyncTask,
  executeZoneSyncbackTask,
  executeZoneShellTask,
  executeZoneProvisionTask,
} from '../TaskManager/ZoneProvisionManager.js';
import {
  executeZoneProvisionRemoteTask,
  executeZoneDockerComposeTask,
  executeZoneHookTask,
  executeZoneKeyRotateTask,
  executeZoneTransportRemoveTask,
} from '../TaskManager/ZoneEngineManager.js';
import {
  executeProvisionerImportTask,
  executeProvisionerCatalogInstallTask,
} from '../TaskManager/ProvisionerImportManager.js';
import { executeProvisionerExportTask } from '../TaskManager/ProvisionerExportManager.js';
import { executeZoneProvisioningStageTask } from '../TaskManager/ProvisionerStageManager.js';
import {
  executeSnapshotTakeTask,
  executeSnapshotRestoreTask,
  executeSnapshotModifyTask,
  executeSnapshotDeleteTask,
} from '../TaskManager/ZoneSnapshotManager.js';
import { getHostMonitoringService } from '../HostMonitoringService.js';
import { log } from '../../lib/Logger.js';

/**
 * @fileoverview Zone, service, discovery, and VNC task dispatchers
 */

/**
 * Map of operations that pass full task object (need progress tracking)
 */
export const TASK_OBJECT_OPERATIONS = {
  zone_create_storage: executeZoneCreateStorageTask,
  zone_create_config: executeZoneCreateConfigTask,
  zone_create_install: executeZoneCreateInstallTask,
  zone_create_finalize: executeZoneCreateFinalizeTask,
  zone_modify: executeZoneModifyTask,
  zone_setup: executeZoneSetupTask,
  zone_provisioning_extract: executeZoneProvisioningExtractTask,
  zone_provisioning_stage: executeZoneProvisioningStageTask,
  provisioner_import: executeProvisionerImportTask,
  snapshot_take: executeSnapshotTakeTask,
  snapshot_restore: executeSnapshotRestoreTask,
  snapshot_modify: executeSnapshotModifyTask,
  snapshot_delete: executeSnapshotDeleteTask,
  zone_wait_ssh: executeZoneWaitSSHTask,
  zone_sync: executeZoneSyncTask,
  zone_syncback: executeZoneSyncbackTask,
  zone_shell: executeZoneShellTask,
  zone_docker_compose: executeZoneDockerComposeTask,
  zone_hook: executeZoneHookTask,
  zone_provision: executeZoneProvisionTask,
  zone_provision_remote: executeZoneProvisionRemoteTask,
  zone_key_rotate: executeZoneKeyRotateTask,
  zone_transport_remove: executeZoneTransportRemoveTask,
  provisioner_export: executeProvisionerExportTask,
  provisioner_catalog_install: executeProvisionerCatalogInstallTask,
};

/**
 * Execute zone-related tasks
 * @param {string} operation - Operation type
 * @param {string} zoneName - Zone name
 * @param {string} [metadata] - Optional JSON metadata string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneTask = (operation, zoneName, metadata) => {
  switch (operation) {
    case 'start':
      return executeStartTask(zoneName);
    case 'stop':
      return executeStopTask(zoneName);
    case 'restart':
      return executeRestartTask(zoneName);
    case 'reset':
      return executeResetTask(zoneName);
    case 'suspend':
      return executeSuspendTask(zoneName);
    case 'resume':
      return executeResumeTask(zoneName);
    case 'delete':
      return executeDeleteTask(zoneName, metadata);
    case 'zone_attach':
      return executeZoneAttachTask(zoneName, metadata);
    case 'zone_detach':
      return executeZoneDetachTask(zoneName);
    case 'zone_move':
      return executeZoneMoveTask(zoneName, metadata);
    case 'discover':
      return executeDiscoverTask();
    default:
      return { success: false, error: `Unknown zone operation: ${operation}` };
  }
};

/**
 * Execute service-related tasks
 * @param {string} operation - Operation type
 * @param {string} zoneName - Zone name
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeServiceTask = (operation, zoneName) => {
  switch (operation) {
    case 'service_enable':
      return enableService(zoneName);
    case 'service_disable':
      return disableService(zoneName);
    case 'service_restart':
      return restartService(zoneName);
    case 'service_refresh':
      return refreshService(zoneName);
    default:
      return { success: false, error: `Unknown service operation: ${operation}` };
  }
};

/**
 * Execute host monitoring discovery tasks
 * @param {string} operation - Operation type
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDiscoveryTask = async operation => {
  const hostMonitoringService = getHostMonitoringService();

  try {
    let success = false;
    let message = '';

    switch (operation) {
      case 'network_config_discovery':
        success = await hostMonitoringService.networkCollector.collectNetworkConfig();
        message = 'Network configuration collected';
        break;

      case 'network_usage_discovery':
        success = await hostMonitoringService.networkCollector.collectNetworkUsage();
        message = 'Network usage collected';
        break;

      case 'storage_discovery':
        success = await hostMonitoringService.storageCollector.collectStorageData();
        message = 'Storage data collected';
        break;

      case 'storage_frequent_discovery':
        success = await hostMonitoringService.storageCollector.collectFrequentStorageMetrics();
        message = 'Storage metrics collected';
        break;

      case 'device_discovery':
        success = await hostMonitoringService.deviceCollector.collectPCIDevices();
        message = 'PCI devices collected';
        break;

      case 'system_metrics_discovery':
        success = await hostMonitoringService.systemMetricsCollector.collectSystemMetrics();
        message = 'System metrics collected';
        break;

      default:
        return { success: false, error: `Unknown discovery operation: ${operation}` };
    }

    return {
      success: success !== false,
      message,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
};

/**
 * Execute VNC start task for auto-VNC functionality
 * @param {string} zoneName - Zone name
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeVncStartTask = async zoneName => {
  try {
    log.task.info('Auto-starting VNC session for zone', { zone_name: zoneName });

    const { spawn } = await import('child_process');
    const { findAvailablePort } = await import('../VncConsoleController/utils/VncValidation.js');
    const { sessionManager } = await import('../VncConsoleController/utils/VncSessionManager.js');
    const VncSessions = (await import('../../models/VncSessionModel.js')).default;

    // Check if zone already has VNC session
    const existingSession = sessionManager.getSessionInfo(zoneName);
    if (existingSession) {
      log.task.debug('Zone already has VNC session', {
        zone_name: zoneName,
        port: existingSession.port,
      });
      return {
        success: true,
        message: `Zone ${zoneName} already has active VNC session on port ${existingSession.port}`,
      };
    }

    // Find available port
    const webPort = await findAvailablePort();
    const netport = `0.0.0.0:${webPort}`;

    // Spawn VNC process
    const vncProcess = spawn('pfexec', ['zadm', 'vnc', '-w', netport, zoneName], {
      detached: true,
      stdio: 'ignore',
    });

    if (!vncProcess.pid) {
      throw new Error('Failed to spawn VNC process');
    }

    // Write session info
    sessionManager.writeSessionInfo(zoneName, vncProcess.pid, 'auto_vnc', netport);

    // Update database
    await VncSessions.destroy({ where: { zone_name: zoneName } });
    await VncSessions.create({
      zone_name: zoneName,
      web_port: webPort,
      host_ip: '127.0.0.1',
      process_id: vncProcess.pid,
      status: 'active',
      created_at: new Date(),
      last_accessed: new Date(),
    });

    // Detach process
    vncProcess.unref();

    log.task.info('Auto-VNC session started', {
      zone_name: zoneName,
      port: webPort,
      pid: vncProcess.pid,
    });

    return {
      success: true,
      message: `VNC session auto-started for zone ${zoneName} on port ${webPort}`,
    };
  } catch (error) {
    log.task.error('Failed to auto-start VNC session', {
      zone_name: zoneName,
      error: error.message,
    });
    return {
      success: false,
      error: `Failed to auto-start VNC session: ${error.message}`,
    };
  }
};
