import { executeCommand } from '../../../lib/CommandManager.js';
import { getRootPool } from '../../../lib/DiskSpec.js';
import { syncZoneToDatabase } from '../../../lib/ZoneConfigUtils.js';
import Zones from '../../../models/ZoneModel.js';
import Template from '../../../models/TemplateModel.js';
import Tasks from '../../../models/TaskModel.js';
import { log } from '../../../lib/Logger.js';
import { parseAsync } from '../../../lib/AsyncJson.js';
import { buildDatasetPath } from './utils/ConfigBuilders.js';
import { prepareStorage } from './StorageManager.js';
import { applyAllZoneConfig } from './ConfigurationManager.js';
import { rollbackCreation, storeInfrastructureConfig } from './ZoneLifecycle.js';
import { updateTaskProgress } from '../../../lib/TaskProgressHelper.js';

/**
 * @fileoverview Zone creation orchestrated sub-task executors (4-step pipeline)
 */

/**
 * Execute zone creation storage task (sub-task 1 of 4)
 * Handles boot volume creation and template import
 * @param {Object} task - Task object from database
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneCreateStorageTask = async task => {
  log.task.debug('Zone creation storage task starting', {
    task_id: task.id,
    zone_name: task.zone_name,
  });

  const zfsCreated = [];
  const zoneName = task.zone_name;

  try {
    await updateTaskProgress(task, 5, { status: 'validating' });
    const metadata = await parseAsync(task.metadata);

    // Ensure server_id is set if provided
    if (metadata.settings?.server_id) {
      metadata.server_id = String(metadata.settings.server_id).padStart(4, '0');
    }

    // Typed wire: a template boot entry not yet enriched (auto-download path)
    // resolves the freshly downloaded template here.
    if (metadata.disks?.boot?.type === 'template' && !metadata.disks.boot.template_dataset) {
      const [org, boxName] = metadata.settings.box.split('/');
      const requestedVersion = metadata.settings.box_version || 'latest';
      const architecture = metadata.settings.box_arch || 'amd64';

      let template;
      if (requestedVersion === 'latest') {
        template = await Template.findOne({
          where: { organization: org, box_name: boxName, architecture, provider: 'zone' },
          order: [['version', 'DESC']],
        });
      } else {
        template = await Template.findOne({
          where: {
            organization: org,
            box_name: boxName,
            version: requestedVersion,
            architecture,
            provider: 'zone',
          },
        });
      }

      if (!template) {
        throw new Error(`Template ${org}/${boxName} v${requestedVersion} not found after download`);
      }

      // Enrich the TYPED boot entry with the resolved template dataset
      metadata.disks.boot.template_dataset = template.dataset_path;

      log.task.info('Resolved template from database after download', {
        box: `${org}/${boxName}`,
        version: template.version,
        dataset_path: template.dataset_path,
      });
    }

    const { onData } = task;
    const bootdiskPath = await prepareStorage(metadata, zoneName, zfsCreated, task, onData);

    // Store output for next task
    metadata._execution_output = {
      bootdiskPath,
      zfsCreated,
    };

    await task.update({ metadata: JSON.stringify(metadata) });
    await updateTaskProgress(task, 100, { status: 'completed' });

    log.task.info('Zone creation storage task completed', {
      zone_name: zoneName,
      bootdiskPath,
    });

    return { success: true, message: `Storage prepared for zone ${zoneName}` };
  } catch (error) {
    log.task.error('Zone creation storage task exception', {
      error: error.message,
      stack: error.stack,
      zone_name: zoneName,
    });

    await rollbackCreation(zoneName, false, zfsCreated);

    return { success: false, error: `Storage preparation failed: ${error.message}` };
  }
};

/**
 * Execute zone creation config task (sub-task 2 of 4)
 * Applies zone configuration via zonecfg
 * @param {Object} task - Task object from database
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneCreateConfigTask = async task => {
  log.task.debug('Zone creation config task starting', {
    task_id: task.id,
    zone_name: task.zone_name,
  });

  const zoneName = task.zone_name;
  let zonecfgApplied = false;

  try {
    const metadata = await parseAsync(task.metadata);

    // Query storage task to get its updated metadata
    const storageTask = await Tasks.findByPk(task.depends_on);
    if (!storageTask) {
      throw new Error('Storage task not found');
    }

    const storageMetadata = await parseAsync(storageTask.metadata);

    // Merge storage task's execution output and server_id
    const bootdiskPath = storageMetadata._execution_output?.bootdiskPath;
    const zfsCreated = storageMetadata._execution_output?.zfsCreated || [];
    metadata.server_id = storageMetadata.server_id;

    const { onData } = task;

    // Apply all zone configuration
    await applyAllZoneConfig(zoneName, metadata, bootdiskPath, zfsCreated, task, onData);
    zonecfgApplied = true;

    // Store output for potential rollback
    metadata._execution_output = {
      ...metadata._execution_output,
      zonecfgApplied: true,
    };

    await task.update({ metadata: JSON.stringify(metadata) });
    await updateTaskProgress(task, 100, { status: 'completed' });

    log.task.info('Zone creation config task completed', { zone_name: zoneName });

    return { success: true, message: `Zone ${zoneName} configured successfully` };
  } catch (error) {
    log.task.error('Zone creation config task exception', {
      error: error.message,
      stack: error.stack,
      zone_name: zoneName,
    });

    // Rollback zone config if applied
    if (zonecfgApplied) {
      await executeCommand(`pfexec zonecfg -z ${zoneName} delete -F`);
    }

    return { success: false, error: `Zone configuration failed: ${error.message}` };
  }
};

/**
 * Execute zone creation install task (sub-task 3 of 4)
 * Installs the zone via zoneadm install
 * @param {Object} task - Task object from database
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneCreateInstallTask = async task => {
  log.task.debug('Zone creation install task starting', {
    task_id: task.id,
    zone_name: task.zone_name,
  });

  const zoneName = task.zone_name;

  try {
    const metadata = await parseAsync(task.metadata);

    // Ensure server_id is set from settings if not at top level
    if (!metadata.server_id && metadata.settings?.server_id) {
      metadata.server_id = String(metadata.settings.server_id).padStart(4, '0');
    }

    const { onData } = task;

    await updateTaskProgress(task, 10, { status: 'installing_zone' });

    const installResult = await executeCommand(
      `pfexec zoneadm -z ${zoneName} install`,
      3600 * 1000,
      onData
    );
    if (!installResult.success) {
      throw new Error(`Zone installation failed: ${installResult.error}`);
    }

    await updateTaskProgress(task, 90, { status: 'setting_permissions' });

    // Open the ZONE DIRECTORY (the zonepath's PARENT) for service-user
    // traversal to the provisioning sub-dataset — NEVER the zonepath itself:
    // zoneadm requires it root-owned 0700 (zonecfg(8)) and re-tightens it
    // every boot.
    const pool = metadata.disks?.boot?.pool || (await getRootPool());
    const dataset = metadata.disks?.boot?.dataset || 'zones';
    const datasetPath = buildDatasetPath(`${pool}/${dataset}`, zoneName, metadata.server_id);
    const zoneDir = metadata.zonepath
      ? metadata.zonepath.replace(/\/path$/u, '')
      : `/${datasetPath}`;

    const chmodResult = await executeCommand(`pfexec chmod 755 ${zoneDir}`);
    if (!chmodResult.success) {
      log.task.warn('Failed to open zone directory for service user', {
        zone_dir: zoneDir,
        error: chmodResult.error,
      });
    }

    await updateTaskProgress(task, 100, { status: 'completed' });

    log.task.info('Zone creation install task completed', { zone_name: zoneName });

    return { success: true, message: `Zone ${zoneName} installed successfully` };
  } catch (error) {
    log.task.error('Zone creation install task exception', {
      error: error.message,
      stack: error.stack,
      zone_name: zoneName,
    });

    return { success: false, error: `Zone installation failed: ${error.message}` };
  }
};

/**
 * Execute zone creation finalize task (sub-task 4 of 4)
 * Syncs zone to database and stores configuration
 * @param {Object} task - Task object from database
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneCreateFinalizeTask = async task => {
  log.task.debug('Zone creation finalize task starting', {
    task_id: task.id,
    zone_name: task.zone_name,
  });

  const zoneName = task.zone_name;

  try {
    const metadata = await parseAsync(task.metadata);

    // Ensure server_id is set from settings if not at top level
    if (!metadata.server_id && metadata.settings?.server_id) {
      metadata.server_id = String(metadata.settings.server_id).padStart(4, '0');
    }

    await updateTaskProgress(task, 10, { status: 'syncing_to_database' });
    await syncZoneToDatabase(zoneName, 'configured');

    const zoneRecord = await Zones.findOne({ where: { name: zoneName } });
    if (zoneRecord) {
      const updateFields = {
        server_id: metadata.server_id,
        vm_type: metadata.zones?.vmtype || metadata.vm_type || 'production',
      };
      if (metadata.notes) {
        updateFields.notes = metadata.notes;
      }
      if (Array.isArray(metadata.tags) && metadata.tags.length > 0) {
        updateFields.tags = metadata.tags;
      }
      await zoneRecord.update(updateFields);
    }

    await updateTaskProgress(task, 50, { status: 'syncing_installed_status' });
    await syncZoneToDatabase(zoneName, 'installed');

    await updateTaskProgress(task, 80, { status: 'storing_configuration' });
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (zone) {
      await storeInfrastructureConfig(zone, metadata, zoneName);
    }

    await updateTaskProgress(task, 100, { status: 'completed' });

    log.task.info('Zone creation finalize task completed', { zone_name: zoneName });

    return { success: true, message: `Zone ${zoneName} finalized successfully` };
  } catch (error) {
    log.task.error('Zone creation finalize task exception', {
      error: error.message,
      stack: error.stack,
      zone_name: zoneName,
    });

    return { success: false, error: `Zone finalization failed: ${error.message}` };
  }
};
