import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import Template from '../../models/TemplateModel.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import config from '../../config/ConfigLoader.js';
import { findSourceConfig, queryLatestBoxVersion } from '../../lib/TemplateRegistryUtils.js';
import { buildDatasetPath } from '../TaskManager/ZoneCreationManager/utils/ConfigBuilders.js';
import { attachProvisioningNetwork } from '../../lib/ProvisioningNetwork.js';

/**
 * @fileoverview Zone creation helper functions - template resolution, naming, sub-task creation
 */

/**
 * Derive the zonecfg nic half from the document's networks[] — the DRY
 * ruling (sync 2026-07-18): networks[] is the ONE cross-agent section and
 * the ONLY source of the nic half (the create-body nics[] key is DEAD —
 * the classic system never had one either; Hosts.rb derived everything).
 * Mapping: `bridge` → global-nic (the uplink), `type` internal|external →
 * the vnic-naming class, `mac` (non-auto) → mac-addr, `vlan` → vlan-id.
 * networks[].nic_type is the DRIVER MODEL (virtio) — never the class; it is
 * deliberately not read here. Entry i pairs with net resource i (the
 * declared pairing rule).
 * @param {Object} body - Create request body (mutated)
 */
export const deriveNicsFromNetworks = body => {
  const networks = Array.isArray(body.networks) ? body.networks : [];
  if (networks.length === 0) {
    return;
  }
  body.nics = networks.map(net => {
    const nic = { nic_type: net?.type === 'internal' ? 'internal' : 'external' };
    if (net?.bridge) {
      nic.global_nic = net.bridge;
    }
    const vlan = Number(net?.vlan);
    if (Number.isInteger(vlan) && vlan > 0) {
      nic.vlan_id = vlan;
    }
    if (net?.mac && net.mac !== 'auto') {
      nic.mac_addr = net.mac;
    }
    return nic;
  });
};

/**
 * Declare wire dns entries into the DOCUMENT contract — the MAP shape
 * `[{nameserver: ip}]` the networking role hard-consumes and the package
 * template renders (sync-converged 2026-07-18; Go ships the same declare):
 * plain strings become {nameserver} (empty strings drop), map entries ride
 * untouched.
 * @param {Object} body - Create request body (mutated)
 */
export const declareNetworkDns = body => {
  const networks = Array.isArray(body.networks) ? body.networks : [];
  for (const net of networks) {
    if (net && Array.isArray(net.dns)) {
      net.dns = net.dns
        .filter(entry => !(typeof entry === 'string' && entry.trim() === ''))
        .map(entry => (typeof entry === 'string' ? { nameserver: entry } : entry));
    }
  }
};

/**
 * The create path's network preparation (sync-converged 2026-07-18), ONE
 * call for every create flavor (single, multi-host, clone): a packaged
 * create (provisioner_ref) first gains the provisioning transport entry —
 * dhcp4 on the interconnect, no address; the agent's dhcpd allocates and
 * zone_wait_ssh records the lease — then dns declares into the document
 * shape and the zonecfg nic half derives from networks[].
 * @param {Object} body - Create request body (mutated)
 */
export const prepareNetworkSections = body => {
  if (body.provisioner_ref) {
    attachProvisioningNetwork(body);
  }
  declareNetworkDns(body);
  deriveNicsFromNetworks(body);
};

/**
 * Resolve box reference to template dataset path. Typed wire (disk spec):
 * only a `type: template` boot entry resolves — anything else never touches
 * the box, and an already-enriched entry (template_dataset) passes through.
 * @param {Object} settings - Settings object from request
 * @param {Object} disks - Disks object from request
 * @returns {Promise<{success: boolean, template_dataset?: string, error?: Object}>}
 */
export const resolveBoxToTemplate = async (settings, disks) => {
  if (disks?.boot?.type !== 'template' || !settings.box || disks.boot.template_dataset) {
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
  let lastTaskId = finalizeTask.id;

  // Create-time package staging (Go's machine_prepare parity): a create that
  // names a provisioner lands the working copy — package tree + Hosts.yml —
  // the moment the machine exists, not at first provision. The stage executor
  // reads the STORED document, so it chains after finalize (which stores it).
  const ref = requestBody.provisioner_ref;
  if (ref?.name && ref?.version) {
    const pool = requestBody.disks?.boot?.pool || 'rpool';
    const dataset = requestBody.disks?.boot?.dataset || 'zones';
    const datasetPath = buildDatasetPath(
      `${pool}/${dataset}`,
      zoneName,
      requestBody.settings?.server_id ? String(requestBody.settings.server_id) : ''
    );
    const stageTask = await Tasks.create({
      zone_name: zoneName,
      operation: 'zone_provisioning_stage',
      priority: TaskPriority.MEDIUM,
      created_by: createdBy,
      parent_task_id: parentTaskId,
      depends_on: finalizeTask.id,
      metadata: JSON.stringify({
        provisioner_name: ref.name,
        provisioner_version: ref.version,
        dataset_path: `/${datasetPath}/provisioning`,
      }),
      status: 'pending',
    });
    subTasks.stage = stageTask.id;
    lastTaskId = stageTask.id;
  }

  // Optional: Start task
  if (startAfterCreate) {
    const startTask = await Tasks.create({
      zone_name: zoneName,
      operation: 'start',
      priority: TaskPriority.MEDIUM,
      created_by: createdBy,
      parent_task_id: parentTaskId,
      depends_on: lastTaskId,
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
 * @param {string|null} [firstDependency] - Task the download gates on (the ensure hook's last setup task)
 * @returns {Promise<Object>} Response object
 */
export const handleAutoDownload = async (
  finalZoneName,
  requestBody,
  settings,
  startAfterCreate,
  createdBy,
  firstDependency = null
) => {
  const sourceResult = determineSourceFromBoxUrl(settings.box_url);
  if (!sourceResult.success) {
    throw new Error(sourceResult.error);
  }

  const [org, boxName] = settings.box.split('/');

  // Download-honesty rule: the download URL embeds the version verbatim, so
  // 'latest' must resolve to a concrete version BEFORE anything is queued —
  // and before the parent task exists, so a failed resolution leaves nothing
  // behind.
  let version = settings.box_version || 'latest';
  if (version === 'latest') {
    const sourceConfig = findSourceConfig(sourceResult.source_name);
    if (!sourceConfig) {
      throw new Error(`Template source '${sourceResult.source_name}' not found or disabled`);
    }
    version = await queryLatestBoxVersion(org, boxName, sourceConfig);
    log.api.info('Resolved latest box version for auto-download', {
      box: settings.box,
      version,
    });
  }

  // The orchestration parent is a pure anchor: born running, never
  // dispatched; the child rollup drives its state (the Go queue's model).
  const parentTask = await Tasks.create({
    zone_name: finalZoneName,
    operation: 'zone_create_orchestration',
    priority: TaskPriority.MEDIUM,
    created_by: createdBy,
    metadata: JSON.stringify(requestBody),
    status: 'running',
    started_at: new Date(),
  });

  const downloadTask = await Tasks.create({
    zone_name: 'system',
    operation: 'template_download',
    priority: TaskPriority.MEDIUM,
    created_by: createdBy,
    parent_task_id: parentTask.id,
    depends_on: firstDependency,
    metadata: JSON.stringify({
      source_name: sourceResult.source_name,
      organization: org,
      box_name: boxName,
      version,
      provider: 'zone',
      architecture: settings.box_arch || 'amd64',
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
