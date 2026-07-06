import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import Template from '../../models/TemplateModel.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import config from '../../config/ConfigLoader.js';

/**
 * @fileoverview Zone creation helper functions - template resolution, naming, sub-task creation
 */

/**
 * Resolve box reference to template dataset path
 * @param {Object} settings - Settings object from request
 * @param {Object} disks - Disks object from request
 * @returns {Promise<{success: boolean, template_dataset?: string, error?: Object}>}
 */
export const resolveBoxToTemplate = async (settings, disks) => {
  if (!settings.box || disks?.boot?.source?.template_dataset) {
    return { success: true };
  }

  const [org, boxName] = settings.box.split('/');
  if (!org || !boxName) {
    return {
      success: false,
      error: {
        status: 400,
        message: 'Invalid box format. Expected: "organization/box-name"',
        provided: settings.box,
      },
    };
  }

  const requestedVersion = settings.box_version || 'latest';
  const architecture = settings.box_arch || 'amd64';

  let template;
  if (requestedVersion === 'latest' || !requestedVersion) {
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

  // Verify ZFS dataset actually exists (self-healing for manually deleted templates)
  if (template) {
    const datasetCheck = await executeCommand(`pfexec zfs list ${template.dataset_path}@ready`);
    if (!datasetCheck.success) {
      log.api.warn('Template ZFS dataset missing, removing stale DB record', {
        box: `${org}/${boxName}`,
        dataset_path: template.dataset_path,
        template_id: template.id,
      });
      await template.destroy();
      template = null;
    }
  }

  if (!template) {
    const templateConfig = config.getTemplateSources();
    const defaultSource = templateConfig.sources?.find(
      s => s.enabled && (s.name === 'Default Registry' || s.default)
    );

    return {
      success: false,
      error: {
        status: 404,
        message: 'Template not available locally',
        box: `${org}/${boxName}`,
        requested_version: requestedVersion,
        architecture,
        hint: 'Download template first using POST /templates/pull',
        note: 'For private boxes, include "auth_token" parameter in the download request',
        download_example: {
          source_name: defaultSource?.name || 'Default Registry',
          organization: org,
          box_name: boxName,
          version: requestedVersion === 'latest' ? '<specific version>' : requestedVersion,
          provider: 'zone',
          architecture,
        },
      },
    };
  }

  log.api.info('Resolved box reference to template', {
    box: `${org}/${boxName}`,
    resolved_version: template.version,
    dataset_path: template.dataset_path,
  });

  return { success: true, template_dataset: template.dataset_path };
};

/**
 * Determine source_name from box_url or use default
 * @param {string} [boxUrl] - Optional box URL
 * @returns {{success: boolean, source_name?: string, error?: string}}
 */
const determineSourceFromBoxUrl = boxUrl => {
  const templateConfig = config.getTemplateSources();

  if (boxUrl) {
    const matchingSource = templateConfig.sources?.find(s => s.enabled && boxUrl.startsWith(s.url));
    if (matchingSource) {
      return { success: true, source_name: matchingSource.name };
    }
    return {
      success: false,
      error: `No configured source matches box_url: ${boxUrl}`,
    };
  }

  const defaultSource = templateConfig.sources?.find(
    s => s.enabled && (s.name === 'Default Registry' || s.default)
  );

  if (!defaultSource) {
    return {
      success: false,
      error: 'No default template source configured',
    };
  }

  return { success: true, source_name: defaultSource.name };
};

/**
 * Create zone creation sub-tasks with proper dependencies
 * @param {string} zoneName - Zone name
 * @param {Object} requestBody - Full request body
 * @param {string} parentTaskId - Parent task ID
 * @param {string} [firstDependency] - First task dependency (e.g., template_download)
 * @param {boolean} startAfterCreate - Whether to create start task
 * @param {string} createdBy - Created by identifier
 * @returns {Promise<{subTasks: Object}>}
 */
export const createZoneCreationSubTasks = async (
  zoneName,
  requestBody,
  parentTaskId,
  firstDependency,
  startAfterCreate,
  createdBy
) => {
  const baseMetadata = JSON.stringify(requestBody);

  // Sub-task 1: Storage
  const storageTask = await Tasks.create({
    zone_name: zoneName,
    operation: 'zone_create_storage',
    priority: TaskPriority.MEDIUM,
    created_by: createdBy,
    parent_task_id: parentTaskId,
    depends_on: firstDependency,
    metadata: baseMetadata,
    status: 'pending',
  });

  // Sub-task 2: Config
  const configTask = await Tasks.create({
    zone_name: zoneName,
    operation: 'zone_create_config',
    priority: TaskPriority.MEDIUM,
    created_by: createdBy,
    parent_task_id: parentTaskId,
    depends_on: storageTask.id,
    metadata: baseMetadata,
    status: 'pending',
  });

  // Sub-task 3: Install
  const installTask = await Tasks.create({
    zone_name: zoneName,
    operation: 'zone_create_install',
    priority: TaskPriority.MEDIUM,
    created_by: createdBy,
    parent_task_id: parentTaskId,
    depends_on: configTask.id,
    metadata: baseMetadata,
    status: 'pending',
  });

  // Sub-task 4: Finalize
  const finalizeTask = await Tasks.create({
    zone_name: zoneName,
    operation: 'zone_create_finalize',
    priority: TaskPriority.MEDIUM,
    created_by: createdBy,
    parent_task_id: parentTaskId,
    depends_on: installTask.id,
    metadata: baseMetadata,
    status: 'pending',
  });

  const subTasks = {
    storage: storageTask.id,
    config: configTask.id,
    install: installTask.id,
    finalize: finalizeTask.id,
  };

  // Optional: Start task
  if (startAfterCreate) {
    const startTask = await Tasks.create({
      zone_name: zoneName,
      operation: 'start',
      priority: TaskPriority.MEDIUM,
      created_by: createdBy,
      parent_task_id: parentTaskId,
      depends_on: finalizeTask.id,
      status: 'pending',
    });
    subTasks.start = startTask.id;
  }

  return { subTasks };
};

/**
 * Resolve final zone name with optional server_id prefix
 * @param {string} baseName - Base FQDN (hostname.domain)
 * @param {Object} settings - Request settings object
 * @returns {Promise<{success: boolean, finalZoneName?: string, error?: Object}>}
 */
export const resolveZoneName = async (baseName, settings) => {
  const zonesConfig = config.getZones();

  if (!zonesConfig.prefix_zone_names) {
    return { success: true, finalZoneName: baseName };
  }

  // Prefix mode enabled - server_id is REQUIRED
  if (!settings.server_id) {
    return {
      success: false,
      error: {
        status: 400,
        error: 'server_id required when prefix_zone_names is enabled',
        hint: 'Use GET /machines/ids to find available server IDs',
        config: {
          prefix_zone_names: true,
          constraints: {
            format: 'numeric',
            min_length: 4,
            max_length: 8,
            min_value: 1,
            max_value: 99999999,
          },
        },
      },
    };
  }

  // Validate server_id format (numeric, will be padded to 4 digits minimum)
  if (!/^\d+$/u.test(settings.server_id)) {
    return {
      success: false,
      error: {
        status: 400,
        error: 'server_id must be numeric',
        provided: settings.server_id,
      },
    };
  }

  const serverId = String(settings.server_id).padStart(4, '0');

  // Check if server_id is already in use
  const existingServerId = await Zones.findOne({ where: { server_id: serverId } });
  if (existingServerId) {
    return {
      success: false,
      error: {
        status: 409,
        error: `Server ID ${serverId} is already in use`,
        machine: existingServerId.name,
        hint: 'Use GET /machines/ids/next to get the next available ID',
      },
    };
  }

  return { success: true, finalZoneName: `${serverId}--${baseName}` };
};

/**
 * Handle auto-download scenario for missing templates
 * @param {string} finalZoneName - Final zone name
 * @param {Object} requestBody - Request body
 * @param {Object} settings - Settings object
 * @param {boolean} startAfterCreate - Start after create flag
 * @param {string} createdBy - Created by identifier
 * @returns {Promise<Object>} Response object
 */
export const handleAutoDownload = async (
  finalZoneName,
  requestBody,
  settings,
  startAfterCreate,
  createdBy
) => {
  const parentTask = await Tasks.create({
    zone_name: finalZoneName,
    operation: 'zone_create_orchestration',
    priority: TaskPriority.MEDIUM,
    created_by: createdBy,
    metadata: JSON.stringify(requestBody),
    status: 'pending',
  });

  const sourceResult = determineSourceFromBoxUrl(settings.box_url);
  if (!sourceResult.success) {
    throw new Error(sourceResult.error);
  }

  const [org, boxName] = settings.box.split('/');

  const downloadTask = await Tasks.create({
    zone_name: 'system',
    operation: 'template_download',
    priority: TaskPriority.MEDIUM,
    created_by: createdBy,
    parent_task_id: parentTask.id,
    metadata: JSON.stringify({
      source_name: sourceResult.source_name,
      organization: org,
      box_name: boxName,
      version: settings.box_version || 'latest',
      provider: 'zone',
      architecture: settings.box_arch || 'amd64',
      auth_token: settings.box_auth_token,
    }),
    status: 'pending',
  });

  const { subTasks } = await createZoneCreationSubTasks(
    finalZoneName,
    requestBody,
    parentTask.id,
    downloadTask.id,
    startAfterCreate,
    createdBy
  );

  return {
    success: true,
    parent_task_id: parentTask.id,
    machine_name: finalZoneName,
    operation: 'zone_create_orchestration',
    status: 'pending',
    message: 'Template download and zone creation queued',
    requires_download: true,
    sub_tasks: {
      template_download: downloadTask.id,
      ...subTasks,
    },
  };
};
