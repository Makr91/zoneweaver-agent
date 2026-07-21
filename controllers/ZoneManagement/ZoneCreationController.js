import Zones from '../../models/ZoneModel.js';
import { log } from '../../lib/Logger.js';
import { validateZoneCreationResources } from '../../lib/ResourceValidation.js';
import { ensureProvisioningNetwork } from '../ProvisioningNetworkController.js';
import { getSystemZoneStatus } from './ZoneQueryController.js';
import {
  resolveBoxToTemplate,
  resolveZoneName,
  handleAutoDownload,
} from './ZoneCreationHelpers.js';
import { preparePackageDocument } from './ZoneCreationDocument.js';
import {
  validateCreateBody,
  enrichBootTemplate,
  firmwareConflictWarning,
  bootStrategyProblem,
  prepareAndValidateDisks,
} from './ZoneCreationValidation.js';
import { queueCreateOrchestration } from './ZoneCreationOrchestration.js';
import { createMultiHostMachines } from './ZoneCreationMultiHost.js';

/**
 * @fileoverview Zone creation controller
 */

export const findExistingZoneConflict = async finalZoneName => {
  const existingZone = await Zones.findOne({ where: { name: finalZoneName } });
  if (existingZone) {
    return { error: `Zone ${finalZoneName} already exists in database` };
  }
  const systemStatus = await getSystemZoneStatus(finalZoneName);
  if (systemStatus !== 'not_found') {
    return {
      error: `Zone ${finalZoneName} already exists on the system`,
      system_status: systemStatus,
    };
  }
  return null;
};

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
 *                   firmware_type:
 *                     type: string
 *                     enum: [UEFI, BIOS]
 *                     description: |
 *                       Guest firmware style (the cross-hypervisor knob). When
 *                       zones.bootrom is absent, BIOS maps the boot ROM to
 *                       BHYVE_RELEASE_CSM and UEFI (the default) to BHYVE_RELEASE.
 *                       An explicit zones.bootrom always wins; BIOS paired with a
 *                       non-CSM ROM answers a resource_warnings entry (that pairing
 *                       cannot legacy boot, and the VNC framebuffer needs UEFI boot).
 *                     example: "UEFI"
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
 *                   bootorder:
 *                     type: string
 *                     description: bhyve boot order (path[N]/bootdisk/disk[N]/cdrom[N]/net[N]/shell tokens)
 *                     example: "cdrom0,bootdisk"
 *                   bootnext:
 *                     type: string
 *                     description: One-shot boot order for the NEXT boot only
 *                     example: "cdrom0"
 *                   guest_agent:
 *                     type: boolean
 *                     description: |
 *                       Wire the QEMU guest-agent channel (virtio-console qga socket) into this
 *                       machine — per-machine option, default off (not every template ships
 *                       qemu-ga). Requires the agent-level guest_agent.enabled config gate.
 *                       Windows guests need hostbridge=q35.
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
 *                 description: |
 *                   Network configuration (Hosts.yml format) — the ONE cross-agent
 *                   network section and the ONLY source of the zonecfg nic half:
 *                   every entry DERIVES its net resource (bridge → global-nic,
 *                   type → the vnic class, mac non-auto → mac-addr, vlan → vlan-id;
 *                   entry i pairs with net resource i; VNIC names are always
 *                   generated). A create that names a provisioner additionally gets
 *                   the PROVISIONING NETWORK attached as one dhcp4 entry on the
 *                   interconnect etherstub (provisional + is_control, NO address —
 *                   the agent's dhcpd allocates and zone_wait_ssh records the lease
 *                   into the document).
 *                 items:
 *                   type: object
 *                   properties:
 *                     type:
 *                       type: string
 *                       enum: [internal, external]
 *                       example: "internal"
 *                     bridge:
 *                       type: string
 *                       description: The uplink datalink (GET /provisioning/bridged-interfaces rows) — becomes the derived nic's global-nic
 *                       example: "igb0"
 *                     nic_type:
 *                       type: string
 *                       description: The guest NIC DRIVER MODEL (Hosts.yml vocabulary, default virtio) — never the vnic class; the class is `type`
 *                       example: "virtio"
 *                     vlan:
 *                       type: integer
 *                       description: VLAN tag on the uplink — becomes the derived nic's vlan-id
 *                       example: 176
 *                     mac:
 *                       type: string
 *                       description: MAC address, or "auto" (default) for a generated one
 *                       example: "auto"
 *                     dhcp4:
 *                       type: boolean
 *                       description: DHCP client entry — the provisioning transport entry uses this (the agent's dhcpd allocates)
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
 *                     route:
 *                       type: string
 *                       description: Guest route destination for this NIC (default "default"; a scoped CIDR keeps the NIC from owning the default route) — rides VERBATIM to guest-side machinery per the guest-owns-routes ruling
 *                       example: "default"
 *                     is_control:
 *                       type: boolean
 *                       description: Whether this is the control/management network
 *                     provisional:
 *                       type: boolean
 *                       description: Whether this is the provisioning network
 *                     dns:
 *                       type: array
 *                       description: |
 *                         DNS servers — the DOCUMENT contract is the map shape
 *                         [{nameserver: ip}] (the networking role consumes it).
 *                         Plain strings are accepted on the wire and DECLARED into
 *                         that shape at create.
 *                       items:
 *                         type: object
 *                         properties:
 *                           nameserver:
 *                             type: string
 *                       example: [{"nameserver": "8.8.8.8"}]
 *               disks:
 *                 type: object
 *                 description: |
 *                   TYPED disk wire (cross-agent disk spec, frozen 2026-07-17): every
 *                   entry DECLARES its type — the agent validates the declaration and
 *                   never infers from key shapes. Omit disks.boot entirely for the
 *                   documented default: template when settings.box is set, else none
 *                   (diskless). VBox placement keys (controller/port/device,
 *                   controllers[]) are accepted and answer a resource_warnings entry —
 *                   they are not used on bhyve. Unknown keys (mount, filesystem,
 *                   driver, …) ride the stored document verbatim (in-guest role data).
 *                   Created zvols are stamped with zoneweaver:source provenance —
 *                   deletion cleanup destroys stamped datasets only.
 *                 properties:
 *                   boot:
 *                     type: object
 *                     required: [type]
 *                     properties:
 *                       type:
 *                         type: string
 *                         enum: [template, image, blank, none]
 *                         description: |
 *                           template = materialize from settings.box (size = grow-to;
 *                           absent size keeps the template's size; clone_strategy
 *                           clone|copy|localize, default copy) · image = attach an
 *                           EXISTING zvol by path (never created or deleted by the
 *                           agent) · blank = create a fresh zvol (size REQUIRED) ·
 *                           none = diskless (takes no other keys)
 *                       size:
 *                         type: string
 *                         description: blank REQUIRES it; template grows to it
 *                         example: "48G"
 *                       sparse:
 *                         type: boolean
 *                         default: true
 *                       volume_name:
 *                         type: string
 *                         default: "boot"
 *                       path:
 *                         type: string
 *                         description: image only — the existing zvol's dataset path
 *                         example: "rpool/vms/old-server/root"
 *                       force:
 *                         type: boolean
 *                         default: false
 *                         description: image only — attach even when another machine references the zvol
 *                       clone_strategy:
 *                         type: string
 *                         enum: [clone, copy, localize]
 *                         default: "copy"
 *                         description: |
 *                           copy (default) = full send|recv, legal on every pool ·
 *                           clone = thin ZFS clone, SAME pool as the template only ·
 *                           localize = one-time template replica onto the target pool
 *                           (GUID-verified, reused thereafter), then thin clone.
 *                           Illegal combinations refuse at the POST with the reason.
 *                       pool:
 *                         type: string
 *                         default: "rpool"
 *                       dataset:
 *                         type: string
 *                         description: Parent dataset path under the pool
 *                         default: "zones"
 *                   additional_disks:
 *                     type: array
 *                     description: Additional disks — same typed entry shape, types image | blank (volume_name defaults diskN)
 *                     items:
 *                       type: object
 *                       required: [type]
 *                       properties:
 *                         type:
 *                           type: string
 *                           enum: [image, blank]
 *                         size:
 *                           type: string
 *                           example: "100G"
 *                         sparse:
 *                           type: boolean
 *                           default: true
 *                         volume_name:
 *                           type: string
 *                           example: "data"
 *                         path:
 *                           type: string
 *                           description: image only — existing zvol dataset path
 *                         force:
 *                           type: boolean
 *                           default: false
 *                         pool:
 *                           type: string
 *                           default: "rpool"
 *                         dataset:
 *                           type: string
 *                           default: "zones"
 *                   cdroms:
 *                     type: array
 *                     description: ISO images to attach — exactly ONE of iso | path per entry (validated)
 *                     items:
 *                       type: object
 *                       properties:
 *                         path:
 *                           type: string
 *                           example: "/iso/omnios-r151050.iso"
 *                         iso:
 *                           type: string
 *                           description: Cached ISO filename resolved through the artifact registry
 *                           example: "debian-12.5.0-amd64-netinst.iso"
 *               filesystems:
 *                 type: array
 *                 description: Filesystem mounts into the zone (generic lofs shares)
 *                 items:
 *                   type: object
 *                   required: [special]
 *                   properties:
 *                     special:
 *                       type: string
 *                       description: Host path to mount
 *                       example: "/data/wipelogs"
 *                     dir:
 *                       type: string
 *                       description: In-zone mount point (defaults to special)
 *                       example: "/data/wipelogs"
 *                     type:
 *                       type: string
 *                       default: "lofs"
 *                     options:
 *                       type: array
 *                       description: Mount options (default [nodevices]; add ro for read-only)
 *                       items:
 *                         type: string
 *                       example: ["ro", "nodevices"]
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
 *               provisioner:
 *                 type: object
 *                 description: |
 *                   OPTIONAL provisioner package reference — when present, the package's
 *                   templates/Hosts.template.yml renders the machine document (settings/
 *                   networks/disks and the provisioner sections) from these inputs, and the
 *                   package stages onto the zone's provisioning dataset at provision time.
 *                   Provisioning is optional — without a reference the request body IS the document.
 *                 properties:
 *                   name:
 *                     type: string
 *                     example: "startcloud_generic_provisioner"
 *                   version:
 *                     type: string
 *                     example: "0.1.27"
 *               roles:
 *                 type: array
 *                 description: Role selections for the package render (boolean enable flags)
 *                 items:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     enabled:
 *                       type: boolean
 *                     files:
 *                       type: object
 *               properties:
 *                 type: object
 *                 description: |
 *                   Field-DSL answers — ONE flat map keyed by exact field name
 *                   (metadata.configuration {groups, fields}; multiselect answers
 *                   are native lists). Validated authoritatively before render:
 *                   errors answer 422 with {FIELD: message}. advanced_properties
 *                   is REMOVED (one cut).
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
 *               remove_transport_on_completion:
 *                 type: boolean
 *                 description: |
 *                   Per-create transport-removal signal (converged wire, 2026-07-18) —
 *                   folds into the agent-attached provisioning entry as its
 *                   remove_on_completion flag. Send ONLY when the user chose; absent =
 *                   this agent's default (REMOVE after the whole-walk stamp — the
 *                   pipeline then removes the provisional NIC, updates the document,
 *                   flips is_control to the real NIC, and power-cycles the machine
 *                   with NO post-boot gate). knob_defaults
 *                   'transport.remove_on_completion' feeds the UI's prefill.
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
 *             with_blank_disk:
 *               summary: Zone with a fresh blank boot disk (typed wire)
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
 *                     type: "blank"
 *                     pool: "rpool"
 *                     dataset: "zones"
 *                     volume_name: "boot"
 *                     size: "30G"
 *                     sparse: true
 *                 networks:
 *                   - type: "external"
 *                     bridge: "igb0"
 *                 start_after_create: true
 *             from_template:
 *               summary: Zone from a box template with an additional blank disk (typed wire)
 *               value:
 *                 settings:
 *                   hostname: "debian-server"
 *                   domain: "startcloud.com"
 *                   server_id: "0002"
 *                   box: "STARTcloud/debian13-server"
 *                   box_version: "2025.8.22"
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
 *                     type: "template"
 *                     clone_strategy: "clone"
 *                     pool: "rpool"
 *                     dataset: "zones"
 *                     volume_name: "boot"
 *                     size: "48G"
 *                     sparse: true
 *                   additional_disks:
 *                     - type: "blank"
 *                       pool: "rpool"
 *                       dataset: "zones"
 *                       volume_name: "data"
 *                       size: "100G"
 *                       sparse: true
 *                 networks:
 *                   - type: "internal"
 *                     bridge: "estub_vz_1"
 *                   - type: "external"
 *                     bridge: "ixgbe1"
 *                     vlan: 11
 *                 start_after_create: false
 *             attach_existing_image:
 *               summary: Zone attaching an EXISTING zvol as its boot disk (typed wire)
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
 *                     type: "image"
 *                     path: "rpool/vms/old-server/root"
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
 *                     type: "template"
 *                 networks:
 *                   - type: "internal"
 *                     bridge: "estub_vz_1"
 *                 start_after_create: false
 *             from_box_latest:
 *               summary: Zone from box (latest version — disks.boot may be omitted entirely, the documented default is template when settings.box is set)
 *               value:
 *                 settings:
 *                   hostname: "latest-test"
 *                   domain: "example.com"
 *                   box: "STARTcloud/debian13-server"
 *                 zones:
 *                   brand: "bhyve"
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
 *                 networks:
 *                   - type: "external"
 *                     bridge: "ixgbe1"
 *                     vlan: 11
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
 *                     stage:
 *                       type: string
 *                       format: uuid
 *                       description: Create-time package staging (only when the create names a provisioner) — lands the working copy the moment the machine exists
 *                     network_setup:
 *                       type: string
 *                       format: uuid
 *                       description: Provisioning-network setup parent task (only when a packaged create found the network missing — the ensure hook queues the idempotent setup chain and the zone's first task gates on it)
 *                     start:
 *                       type: string
 *                       format: uuid
 *                       description: Start task (only if start_after_create is true)
 *       400:
 *         description: Invalid parameters (missing name/brand or invalid zone name)
 *       409:
 *         description: Zone already exists in database or on system
 *       422:
 *         description: Field-DSL answer validation failed — the body IS the {FIELD: message} map (no envelope; shared wire with the Go agent)
 *       500:
 *         description: Failed to queue creation task
 */
export const createZone = async (req, res) => {
  try {
    const { problem, multiHosts } = preparePackageDocument(req.body);
    if (problem) {
      return res.status(problem.status).json(problem.payload);
    }
    if (multiHosts) {
      return createMultiHostMachines(req, res, multiHosts);
    }

    const { settings, start_after_create } = req.body;

    const bodyProblem = validateCreateBody(req.body);
    if (bodyProblem) {
      return res.status(bodyProblem.status).json(bodyProblem.payload);
    }

    const diskPrep = await prepareAndValidateDisks(req.body);
    if (diskPrep.error) {
      return res.status(400).json({ error: diskPrep.error });
    }

    const baseName = `${settings.hostname}.${settings.domain}`;

    const nameResult = await resolveZoneName(baseName, settings);
    if (!nameResult.success) {
      return res.status(nameResult.error.status).json(nameResult.error);
    }
    const { finalZoneName } = nameResult;

    const conflict = await findExistingZoneConflict(finalZoneName);
    if (conflict) {
      return res.status(409).json(conflict);
    }

    const boxResolution = await resolveBoxToTemplate(settings, req.body.disks);

    req.body.name = baseName;

    enrichBootTemplate(req.body, boxResolution);

    const strategyProblem = await bootStrategyProblem(req.body);
    if (strategyProblem) {
      return res.status(400).json({ error: strategyProblem });
    }

    const resourceValidation = await validateZoneCreationResources(req.body);
    if (!resourceValidation.valid) {
      return res.status(400).json({
        error: 'Insufficient resources',
        details: resourceValidation.errors,
      });
    }
    const allWarnings = [...resourceValidation.warnings, ...diskPrep.warnings];
    const firmwareWarning = firmwareConflictWarning(req.body);
    if (firmwareWarning) {
      allWarnings.push(firmwareWarning);
    }

    const networkSetup = req.body.provisioner_ref
      ? await ensureProvisioningNetwork(req.entity.name)
      : null;

    if (!boxResolution.success && boxResolution.error.status === 404) {
      const response = await handleAutoDownload(
        finalZoneName,
        req.body,
        settings,
        start_after_create,
        req.entity.name,
        networkSetup?.lastTaskId ?? null
      );
      if (networkSetup) {
        response.sub_tasks.network_setup = networkSetup.parentTaskId;
      }
      if (allWarnings.length > 0) {
        response.resource_warnings = allWarnings;
      }
      return res.json(response);
    }

    if (!boxResolution.success) {
      return res.status(boxResolution.error.status).json(boxResolution.error);
    }

    const createResponse = await queueCreateOrchestration(
      finalZoneName,
      req.body,
      networkSetup,
      start_after_create,
      req.entity.name,
      allWarnings
    );
    return res.json(createResponse);
  } catch (error) {
    log.database.error('Database error creating zone task', {
      error: error.message,
      zone_name: req.body.name,
      user: req.entity.name,
    });
    return res
      .status(500)
      .json({ error: 'Failed to queue zone creation task', details: error.message });
  }
};
