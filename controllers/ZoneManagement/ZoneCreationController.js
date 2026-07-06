import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import { validateZoneName } from '../../lib/ZoneValidation.js';
import { validateZoneCreationResources } from '../../lib/ResourceValidation.js';
import { getSystemZoneStatus } from './ZoneQueryController.js';
import {
  resolveBoxToTemplate,
  resolveZoneName,
  createZoneCreationSubTasks,
  handleAutoDownload,
} from './ZoneCreationHelpers.js';

/**
 * @fileoverview Zone creation controller
 */

/**
 * @swagger
 * /machines/{machineName}:
 *   delete:
 *     summary: Delete machine
 *     description: Queues tasks to stop, uninstall, and delete the specified machine (zone)
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine to delete
 *       - in: query
 *         name: force
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Force deletion even if zone is running
 *       - in: query
 *         name: cleanup_datasets
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Also destroy ZFS datasets (boot volume, zone root dataset) after zone deletion. External datasets not in the zone hierarchy are skipped for safety.
 *     responses:
 *       200:
 *         description: Delete tasks queued successfully
 *       400:
 *         description: Invalid zone name or zone is running without force
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to queue delete tasks
 */
/**
 * @swagger
 * /machines:
 *   post:
 *     summary: Create a new machine
 *     description: |
 *       Queues a task to create a new zone with the specified configuration using Hosts.yml structure.
 *       Required: `settings.hostname`, `settings.domain`, `zones.brand`
 *       Optional: Box reference (`settings.box`) auto-resolves to template if available locally.
 *       The zone is created via `zonecfg` and installed via `zoneadm install`.
 *       Use `start_after_create` to automatically boot the zone after creation.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [settings, zones]
 *             properties:
 *               settings:
 *                 type: object
 *                 description: Host settings (Hosts.yml format)
 *                 required: [hostname, domain]
 *                 properties:
 *                   hostname:
 *                     type: string
 *                     description: Zone hostname (combined with domain to form FQDN)
 *                     example: "web-server-01"
 *                   domain:
 *                     type: string
 *                     description: Domain name (combined with hostname to form FQDN)
 *                     example: "example.com"
 *                   server_id:
 *                     type: string
 *                     description: Numeric server identifier (required if prefix_zone_names enabled)
 *                     example: "0001"
 *                   box:
 *                     type: string
 *                     description: "Box reference in format 'organization/box-name'. Auto-resolves to template if available locally."
 *                     example: "STARTcloud/debian13-server"
 *                   box_version:
 *                     type: string
 *                     description: "Box version. Defaults to 'latest' if omitted."
 *                     default: "latest"
 *                     example: "2025.8.22"
 *                   box_arch:
 *                     type: string
 *                     description: Box architecture
 *                     default: "amd64"
 *                     example: "amd64"
 *                   box_url:
 *                     type: string
 *                     description: "Box registry URL. Defaults to configured 'Default Registry' if omitted."
 *                     example: "https://boxvault.startcloud.com"
 *                   vcpus:
 *                     type: integer
 *                     description: Number of virtual CPUs
 *                     example: 2
 *                   memory:
 *                     type: string
 *                     description: Memory allocation
 *                     example: "2G"
 *                   os_type:
 *                     type: string
 *                     description: Guest OS type
 *                     example: "Debian_64"
 *                   consoleport:
 *                     type: integer
 *                     description: "Static VNC console port (1025-65535). If specified, this port will be reserved for this zone's VNC console. If omitted, a dynamic port is assigned."
 *                     minimum: 1025
 *                     maximum: 65535
 *                     example: 6001
 *                   consolehost:
 *                     type: string
 *                     description: "VNC bind address. Defaults to '0.0.0.0' (all interfaces). Set to '127.0.0.1' for localhost-only access."
 *                     default: "0.0.0.0"
 *                     example: "0.0.0.0"
 *               zones:
 *                 type: object
 *                 description: Zone configuration (Hosts.yml format)
 *                 required: [brand]
 *                 properties:
 *                   brand:
 *                     type: string
 *                     description: Zone brand
 *                     enum: [bhyve, lx, lipkg, sparse, pkgsrc, kvm]
 *                     example: "bhyve"
 *                   vmtype:
 *                     type: string
 *                     description: VM type classification
 *                     enum: [template, development, production, firewall, other]
 *                     default: "production"
 *                     example: "production"
 *                   hostbridge:
 *                     type: string
 *                     description: Host bridge emulation
 *                     example: "i440fx"
 *                   diskif:
 *                     type: string
 *                     description: Disk interface type
 *                     example: "virtio"
 *                   netif:
 *                     type: string
 *                     description: Network interface type
 *                     example: "virtio-net-viona"
 *                   acpi:
 *                     type: string
 *                     description: ACPI support
 *                     example: "on"
 *                   vnc:
 *                     type: string
 *                     description: VNC console setting
 *                     example: "on"
 *                   autostart:
 *                     type: boolean
 *                     description: Auto-boot zone on system startup
 *                     default: false
 *                   cpu_configuration:
 *                     type: string
 *                     enum: [simple, complex]
 *                     description: "CPU topology mode. 'simple' uses vcpus as-is, 'complex' builds topology string from complex_cpu_conf."
 *                     default: "simple"
 *                     example: "complex"
 *                   complex_cpu_conf:
 *                     type: array
 *                     description: "CPU topology specification (required if cpu_configuration is 'complex'). Array should contain one topology object."
 *                     items:
 *                       type: object
 *                       required: [sockets, cores, threads]
 *                       properties:
 *                         sockets:
 *                           type: integer
 *                           minimum: 1
 *                           maximum: 16
 *                           description: "Number of CPU sockets (bhyve limit: 16)"
 *                           example: 2
 *                         cores:
 *                           type: integer
 *                           minimum: 1
 *                           maximum: 32
 *                           description: "Cores per socket (bhyve limit: 32)"
 *                           example: 2
 *                         threads:
 *                           type: integer
 *                           minimum: 1
 *                           maximum: 2
 *                           description: "Threads per core (SMT: 1 or 2)"
 *                           example: 1
 *                     example:
 *                       - sockets: 2
 *                         cores: 2
 *                         threads: 1
 *               networks:
 *                 type: array
 *                 description: Network configuration (Hosts.yml format)
 *                 items:
 *                   type: object
 *                   properties:
 *                     type:
 *                       type: string
 *                       enum: [internal, external]
 *                       example: "internal"
 *                     address:
 *                       type: string
 *                       description: IP address
 *                       example: "10.190.190.10"
 *                     netmask:
 *                       type: string
 *                       example: "255.255.255.0"
 *                     gateway:
 *                       type: string
 *                       example: "10.190.190.1"
 *                     is_control:
 *                       type: boolean
 *                       description: Whether this is the control/management network
 *                     provisional:
 *                       type: boolean
 *                       description: Whether this is the provisioning network
 *                     dns:
 *                       type: array
 *                       description: DNS servers
 *                       items:
 *                         type: string
 *                       example: ["8.8.8.8"]
 *               disks:
 *                 type: object
 *                 description: Disk configuration. Omit entirely for diskless zones (PXE/netboot).
 *                 properties:
 *                   boot:
 *                     type: object
 *                     description: Boot disk configuration
 *                     properties:
 *                       source:
 *                         type: object
 *                         description: Boot disk source (template or scratch). Omit for existing dataset.
 *                         properties:
 *                           type:
 *                             type: string
 *                             enum: [template, scratch]
 *                             description: "template = clone from template, scratch = blank volume"
 *                             example: "template"
 *                           template_dataset:
 *                             type: string
 *                             description: Template ZFS dataset path (required if type is template)
 *                             example: "rpool/templates/STARTcloud/debian13-server/2025.8.22"
 *                           clone_strategy:
 *                             type: string
 *                             enum: [clone, copy]
 *                             description: "clone = thin ZFS clone (default), copy = full ZFS send/recv"
 *                             default: "clone"
 *                             example: "clone"
 *                       pool:
 *                         type: string
 *                         description: ZFS pool for new volume
 *                         default: "rpool"
 *                         example: "rpool"
 *                       dataset:
 *                         type: string
 *                         description: "Parent dataset path (e.g., 'zones' or 'zones/companyA/suborgB'). For existing zvol, provide full path without pool/volume_name."
 *                         default: "zones"
 *                         example: "zones"
 *                       volume_name:
 *                         type: string
 *                         description: Volume name for new volume
 *                         default: "boot"
 *                         example: "boot"
 *                       size:
 *                         type: string
 *                         description: "Volume size. For templates, volume will be grown if template is smaller."
 *                         default: "48G"
 *                         example: "48G"
 *                       sparse:
 *                         type: boolean
 *                         description: Create sparse volume (thin provisioned)
 *                         default: true
 *                   additional:
 *                     type: array
 *                     description: Additional disks beyond the boot volume
 *                     items:
 *                       type: object
 *                       properties:
 *                         pool:
 *                           type: string
 *                           description: ZFS pool
 *                           default: "rpool"
 *                           example: "rpool"
 *                         dataset:
 *                           type: string
 *                           description: "Parent dataset path or full path for existing zvol"
 *                           default: "zones"
 *                           example: "zones"
 *                         volume_name:
 *                           type: string
 *                           description: Volume name
 *                           example: "data"
 *                         size:
 *                           type: string
 *                           description: Volume size
 *                           example: "100G"
 *                         sparse:
 *                           type: boolean
 *                           description: Create sparse volume
 *                           default: true
 *               nics:
 *                 type: array
 *                 description: Network interfaces to configure
 *                 items:
 *                   type: object
 *                   properties:
 *                     physical:
 *                       type: string
 *                       description: VNIC name. Auto-generated from server_id if omitted.
 *                       example: "vnice3_0001_0"
 *                     global_nic:
 *                       type: string
 *                       description: Bridge/physical NIC for on-demand VNIC creation at zone boot. Omit for pre-created VNICs.
 *                       example: "ixgbe1"
 *                     nic_type:
 *                       type: string
 *                       description: NIC type for auto-naming convention (e=external, i=internal, etc.)
 *                       enum: [external, internal, carp, management, host]
 *                       default: "external"
 *                     vlan_id:
 *                       type: integer
 *                       description: VLAN tag ID
 *                       example: 11
 *                     mac_addr:
 *                       type: string
 *                       description: MAC address for the VNIC
 *                       example: "02:08:20:c1:38:e7"
 *                     allowed_address:
 *                       type: string
 *                       description: IP/prefix for cloud-init allowed-address (e.g. "192.168.1.10/24")
 *                       example: "192.168.1.10/24"
 *               cdroms:
 *                 type: array
 *                 description: ISO images to attach as CD-ROMs
 *                 items:
 *                   type: object
 *                   properties:
 *                     path:
 *                       type: string
 *                       description: Path to ISO file
 *                       example: "/iso/omnios-r151050.iso"
 *               cloud_init:
 *                 type: object
 *                 description: Cloud-init provisioning attributes
 *                 properties:
 *                   enabled:
 *                     type: string
 *                     description: Enable cloud-init (on/off or config filename)
 *                     example: "on"
 *                   dns_domain:
 *                     type: string
 *                     example: "example.com"
 *                   password:
 *                     type: string
 *                     example: "changeme"
 *                   resolvers:
 *                     type: string
 *                     description: Comma-separated DNS resolvers
 *                     example: "8.8.8.8,8.8.4.4"
 *                   sshkey:
 *                     type: string
 *                     description: SSH public key for root access
 *                     example: "ssh-rsa AAAA..."
 *               notes:
 *                 type: string
 *                 nullable: true
 *                 description: Free-form user notes for this zone
 *                 example: "Primary web server"
 *               tags:
 *                 type: array
 *                 nullable: true
 *                 description: User-defined tags for categorization and filtering
 *                 items:
 *                   type: string
 *                 example: ["web", "production", "critical"]
 *               force:
 *                 type: boolean
 *                 description: Force attach zvols even if in use by another zone
 *                 default: false
 *               start_after_create:
 *                 type: boolean
 *                 description: Automatically start zone after creation
 *                 default: false
 *           examples:
 *             minimal:
 *               summary: Minimal zone (hostname + domain + brand only)
 *               value:
 *                 settings:
 *                   hostname: "test-vm-01"
 *                   domain: "example.com"
 *                 zones:
 *                   brand: "bhyve"
 *             with_scratch_disk:
 *               summary: Zone with blank scratch disk
 *               value:
 *                 settings:
 *                   hostname: "web-server-01"
 *                   domain: "example.com"
 *                   server_id: "0001"
 *                   vcpus: 2
 *                   memory: "2G"
 *                 zones:
 *                   brand: "bhyve"
 *                   vmtype: "production"
 *                 disks:
 *                   boot:
 *                     source:
 *                       type: "scratch"
 *                     pool: "rpool"
 *                     dataset: "zones"
 *                     volume_name: "boot"
 *                     size: "30G"
 *                     sparse: true
 *                 nics:
 *                   - global_nic: "igb0"
 *                     nic_type: "external"
 *                 start_after_create: true
 *             from_template:
 *               summary: Zone from template with additional disk
 *               value:
 *                 settings:
 *                   hostname: "debian-server"
 *                   domain: "startcloud.com"
 *                   server_id: "0002"
 *                   vcpus: 4
 *                   memory: "4G"
 *                 zones:
 *                   brand: "bhyve"
 *                   vmtype: "production"
 *                   hostbridge: "i440fx"
 *                   diskif: "virtio"
 *                   netif: "virtio-net-viona"
 *                 disks:
 *                   boot:
 *                     source:
 *                       type: "template"
 *                       template_dataset: "rpool/templates/STARTcloud/debian13-server/2025.8.22"
 *                       clone_strategy: "clone"
 *                     pool: "rpool"
 *                     dataset: "zones"
 *                     volume_name: "boot"
 *                     size: "48G"
 *                     sparse: true
 *                   additional:
 *                     - pool: "rpool"
 *                       dataset: "zones"
 *                       volume_name: "data"
 *                       size: "100G"
 *                       sparse: true
 *                 nics:
 *                   - global_nic: "estub_vz_1"
 *                     nic_type: "internal"
 *                   - global_nic: "ixgbe1"
 *                     vlan_id: 11
 *                     nic_type: "external"
 *                 start_after_create: false
 *             existing_dataset:
 *               summary: Zone with existing dataset
 *               value:
 *                 settings:
 *                   hostname: "migrated-vm"
 *                   domain: "example.com"
 *                   vcpus: 4
 *                   memory: "4G"
 *                 zones:
 *                   brand: "bhyve"
 *                 disks:
 *                   boot:
 *                     dataset: "rpool/vms/old-server/root"
 *             from_box_reference:
 *               summary: Zone from box reference (auto-resolve template)
 *               value:
 *                 settings:
 *                   hostname: "auto-resolved"
 *                   domain: "startcloud.com"
 *                   server_id: "0003"
 *                   box: "STARTcloud/debian13-server"
 *                   box_version: "2025.8.22"
 *                   box_arch: "amd64"
 *                   vcpus: 2
 *                   memory: "4G"
 *                 zones:
 *                   brand: "bhyve"
 *                   vmtype: "production"
 *                 disks:
 *                   boot:
 *                     source:
 *                       type: "template"
 *                 nics:
 *                   - global_nic: "estub_vz_1"
 *                     nic_type: "internal"
 *                 start_after_create: false
 *             from_box_latest:
 *               summary: Zone from box (latest version)
 *               value:
 *                 settings:
 *                   hostname: "latest-test"
 *                   domain: "example.com"
 *                   box: "STARTcloud/debian13-server"
 *                 zones:
 *                   brand: "bhyve"
 *                 disks:
 *                   boot:
 *                     source:
 *                       type: "template"
 *             with_complex_cpu:
 *               summary: Zone with complex CPU topology
 *               value:
 *                 settings:
 *                   hostname: "high-performance"
 *                   domain: "example.com"
 *                   server_id: "0010"
 *                   vcpus: 8
 *                   memory: "16G"
 *                 zones:
 *                   brand: "bhyve"
 *                   vmtype: "production"
 *                   cpu_configuration: "complex"
 *                   complex_cpu_conf:
 *                     - sockets: 2
 *                       cores: 2
 *                       threads: 2
 *                   hostbridge: "i440fx"
 *                   diskif: "virtio"
 *                   netif: "virtio-net-viona"
 *                 disks:
 *                   boot:
 *                     source:
 *                       type: "template"
 *                       template_dataset: "rpool/templates/STARTcloud/debian13-server/2025.8.22"
 *                 nics:
 *                   - global_nic: "ixgbe1"
 *                     vlan_id: 11
 *                     nic_type: "external"
 *     responses:
 *       200:
 *         description: Zone creation orchestration queued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 parent_task_id:
 *                   type: string
 *                   format: uuid
 *                   description: Parent orchestration task ID (poll this for overall progress)
 *                 machine_name:
 *                   type: string
 *                   example: "0001--web-server-01.example.com"
 *                 operation:
 *                   type: string
 *                   example: "zone_create_orchestration"
 *                 status:
 *                   type: string
 *                   example: "pending"
 *                 message:
 *                   type: string
 *                   example: "Template download and zone creation queued"
 *                 requires_download:
 *                   type: boolean
 *                   description: Whether template auto-download was triggered
 *                   example: true
 *                 sub_tasks:
 *                   type: object
 *                   description: IDs of all sub-tasks
 *                   properties:
 *                     template_download:
 *                       type: string
 *                       format: uuid
 *                       description: Template download task (only if requires_download is true)
 *                     storage:
 *                       type: string
 *                       format: uuid
 *                     config:
 *                       type: string
 *                       format: uuid
 *                     install:
 *                       type: string
 *                       format: uuid
 *                     finalize:
 *                       type: string
 *                       format: uuid
 *                     start:
 *                       type: string
 *                       format: uuid
 *                       description: Start task (only if start_after_create is true)
 *       400:
 *         description: Invalid parameters (missing name/brand or invalid zone name)
 *       409:
 *         description: Zone already exists in database or on system
 *       500:
 *         description: Failed to queue creation task
 */
export const createZone = async (req, res) => {
  try {
    // NEW HOSTS.YML STRUCTURE ONLY
    const { settings, zones, start_after_create } = req.body;

    if (!settings?.hostname || !settings?.domain || !zones?.brand) {
      return res.status(400).json({
        error:
          'Missing required parameters: settings.hostname, settings.domain, and zones.brand are required',
      });
    }

    // Build base FQDN: hostname.domain
    const baseName = `${settings.hostname}.${settings.domain}`;

    if (!validateZoneName(baseName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    // Resolve final zone name (applies server_id prefix if configured)
    const nameResult = await resolveZoneName(baseName, settings);
    if (!nameResult.success) {
      return res.status(nameResult.error.status).json(nameResult.error);
    }
    const { finalZoneName } = nameResult;

    // Check zone doesn't exist in DB (using final name)
    const existingZone = await Zones.findOne({ where: { name: finalZoneName } });
    if (existingZone) {
      return res.status(409).json({ error: `Zone ${finalZoneName} already exists in database` });
    }

    // Check zone doesn't exist on system (using final name)
    const systemStatus = await getSystemZoneStatus(finalZoneName);
    if (systemStatus !== 'not_found') {
      return res.status(409).json({
        error: `Zone ${finalZoneName} already exists on the system`,
        system_status: systemStatus,
      });
    }

    // Box resolution: convert settings.box reference to template_dataset path
    const boxResolution = await resolveBoxToTemplate(settings, req.body.disks);

    // Ensure metadata.name is set for task executor (base name, not prefixed)
    req.body.name = baseName;

    // Template found locally - inject template_dataset
    if (boxResolution.success && boxResolution.template_dataset) {
      req.body.disks = req.body.disks || {};
      req.body.disks.boot = req.body.disks.boot || {};
      req.body.disks.boot.source = {
        type: 'template',
        template_dataset: boxResolution.template_dataset,
        clone_strategy: 'clone',
      };
    }

    // Validate resource availability (storage space) before creating any tasks
    const resourceValidation = await validateZoneCreationResources(req.body);
    if (!resourceValidation.valid) {
      return res.status(400).json({
        error: 'Insufficient resources',
        details: resourceValidation.errors,
      });
    }

    // Handle missing template with auto-download
    if (!boxResolution.success && boxResolution.error.status === 404 && settings.box) {
      const response = await handleAutoDownload(
        finalZoneName,
        req.body,
        settings,
        start_after_create,
        req.entity.name
      );
      if (resourceValidation.warnings.length > 0) {
        response.resource_warnings = resourceValidation.warnings;
      }
      return res.json(response);
    }

    // Template missing but cannot auto-download (no box reference)
    if (!boxResolution.success) {
      return res.status(boxResolution.error.status).json(boxResolution.error);
    }

    // Template available - create orchestration with sub-tasks (no download)
    const parentTask = await Tasks.create({
      zone_name: finalZoneName,
      operation: 'zone_create_orchestration',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      metadata: JSON.stringify(req.body),
      status: 'pending',
    });

    // Create zone creation sub-tasks (no download dependency)
    const { subTasks } = await createZoneCreationSubTasks(
      finalZoneName,
      req.body,
      parentTask.id,
      null,
      start_after_create,
      req.entity.name
    );

    const createResponse = {
      success: true,
      parent_task_id: parentTask.id,
      machine_name: finalZoneName,
      operation: 'zone_create_orchestration',
      status: 'pending',
      message: 'Zone creation queued',
      requires_download: false,
      sub_tasks: subTasks,
    };
    if (resourceValidation.warnings.length > 0) {
      createResponse.resource_warnings = resourceValidation.warnings;
    }
    return res.json(createResponse);
  } catch (error) {
    log.database.error('Database error creating zone task', {
      error: error.message,
      zone_name: req.body.name,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue zone creation task' });
  }
};
