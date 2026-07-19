import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';
import {
  validateZoneName,
  consoleportRangeError,
  vcpusCountError,
} from '../../lib/ZoneValidation.js';
import { normalizeDisks, validateDisksWire, validateDiskImages } from '../../lib/DiskSpec.js';
import { validateZoneCreationResources } from '../../lib/ResourceValidation.js';
import { getPackageVersion } from '../../lib/ProvisionerRegistry.js';
import { validateAnswers } from '../../lib/FieldDsl.js';
import {
  renderHostsTemplate,
  parseHostsDocuments,
  splitHostsDocument,
  findLegacyMarkers,
  buildShowIfRoleFlags,
  versionConfiguration,
} from '../../lib/HostsTemplateRenderer.js';
import { getSystemZoneStatus } from './ZoneQueryController.js';
import {
  resolveBoxToTemplate,
  resolveZoneName,
  createZoneCreationSubTasks,
  handleAutoDownload,
  prepareNetworkSections,
} from './ZoneCreationHelpers.js';

/**
 * Stamp one rendered host entry's provisioner sections and split infra —
 * shared by the single- and multi-host paths.
 * @param {Object} host - One rendered hosts[] entry
 * @param {Object} ref - The request's provisioner reference
 * @param {Object} pkg - Registry version entry
 * @returns {{infra: Object, provisioner: Object}}
 */
const splitAndStampHost = (host, ref, pkg) => {
  const { infra, provisioner } = splitHostsDocument(host);
  if (!provisioner.provisioner_name) {
    provisioner.provisioner_name = ref.name;
  }
  if (!provisioner.provisioner_version) {
    provisioner.provisioner_version = pkg.version;
  }
  return { infra, provisioner };
};

/**
 * Build a standalone create body for one host of a MULTI-HOST render (§5
 * hosts[]): each machine gets its own document; each machine's zonecfg nic
 * half derives from its OWN rendered networks[].
 * @param {Object} host - One rendered hosts[] entry
 * @param {Object} body - The original request body
 * @param {Object} ref - Provisioner reference
 * @param {Object} pkg - Registry version entry
 * @returns {Object} Per-machine create body
 */
const buildMultiHostBody = (host, body, ref, pkg) => {
  const { infra, provisioner } = splitAndStampHost(host, ref, pkg);
  const sub = {
    settings: infra.settings || {},
    networks: infra.networks || [],
    provisioner,
    provisioner_ref: { name: ref.name, version: pkg.version },
    force: body.force,
    start_after_create: body.start_after_create,
  };
  if (infra.disks) {
    sub.disks = infra.disks;
  }
  if (infra.zones) {
    sub.zones = { ...(body.zones || {}), ...infra.zones };
  }
  if (infra.cloud_init) {
    sub.cloud_init = infra.cloud_init;
  }
  return sub;
};

/**
 * Fold ONE rendered host's infra sections back into the request body — the
 * single-host path's document-wins merge (the rendered document REPLACES the
 * request where it speaks; zones merges shallowly).
 * @param {Object} body - Request body (mutated in place)
 * @param {Object} host - The rendered hosts[0] entry
 * @param {Object} ref - Provisioner reference
 * @param {Object} pkg - Registry version entry
 * @param {Object} settings - The render-input settings (fallback)
 */
const applySingleHostDocument = (body, host, ref, pkg, settings) => {
  const { infra, provisioner } = splitAndStampHost(host, ref, pkg);
  body.settings = infra.settings || settings;
  if (infra.networks) {
    body.networks = infra.networks;
  }
  if (infra.disks) {
    body.disks = infra.disks;
  }
  if (infra.zones) {
    body.zones = { ...(body.zones || {}), ...infra.zones };
  }
  if (infra.cloud_init) {
    body.cloud_init = infra.cloud_init;
  }
  body.provisioner = provisioner;
  body.provisioner_ref = { name: ref.name, version: pkg.version };
};

const renderPackageDocument = body => {
  const ref = body.provisioner;
  if (!ref) {
    return {};
  }
  if (
    !ref.name ||
    !ref.version ||
    typeof ref.name !== 'string' ||
    typeof ref.version !== 'string'
  ) {
    return {
      error: 'provisioner needs both name and version — or neither: provisioning is optional',
    };
  }
  if (body.advanced_properties !== undefined) {
    return {
      error:
        'advanced_properties is removed — the field DSL takes ONE flat answers map in properties',
    };
  }
  const pkg = getPackageVersion(ref.name, ref.version);
  if (!pkg) {
    return { error: `provisioner ${ref.name}/${ref.version} is not in the registry` };
  }

  // AUTHORITATIVE pre-render answer validation (§3.1) — the 422
  // {FIELD: message} wire. Defaults merge before conditionals; hidden
  // fields' answers are never collected. show_if role operands ride the
  // ruled <role name>_enabled spelling.
  const { errors } = validateAnswers(
    versionConfiguration(pkg.metadata),
    body.properties || {},
    buildShowIfRoleFlags(body.roles || [])
  );
  if (Object.keys(errors).length > 0) {
    return { field_errors: errors };
  }

  const settings = { ...(body.settings || {}) };
  if (!settings.sync_method) {
    settings.sync_method = 'rsync';
  }
  // The TWO ruled render-context injections (Mark, 2026-07-17 — both
  // agents): sync_method above, default_network_interface here (config
  // knob provisioning.default_network_interface; '' when unset — an
  // absent key renders empty either way).
  if (!settings.default_network_interface) {
    settings.default_network_interface = config.get('provisioning.default_network_interface') || '';
  }
  const rendered = renderHostsTemplate({
    version: pkg,
    settings,
    networks: body.networks || [],
    roles: body.roles || [],
    properties: body.properties || {},
    // The request's disks ride the render context (defaults-never-locks,
    // disks half) — a converted template echoes them with defaults; until
    // then the key is inert.
    disks: body.disks || {},
  });
  const markers = findLegacyMarkers(rendered);
  const hosts = parseHostsDocuments(rendered);

  if (hosts.length > 1) {
    return {
      markers,
      multi_hosts: hosts.map(host => buildMultiHostBody(host, body, ref, pkg)),
    };
  }

  applySingleHostDocument(body, hosts[0], ref, pkg, settings);
  return { markers };
};

/**
 * Render the package document (when a provisioner reference rides the body).
 * @param {Object} body - Request body (mutated in place for single-host)
 * @returns {{problem?: {status: number, payload: Object}, multiHosts?: Array}}
 */
const preparePackageDocument = body => {
  if (!body.provisioner) {
    return {};
  }
  try {
    const result = renderPackageDocument(body);
    if (result.error) {
      return { problem: { status: 400, payload: { error: result.error } } };
    }
    if (result.field_errors) {
      // The ruled 422 wire (shared with the Go agent): the body IS the
      // {FIELD: message} map — no envelope.
      return { problem: { status: 422, payload: result.field_errors } };
    }
    if (result.markers?.length > 0) {
      log.api.warn('Rendered document still contains ::TOKEN:: markers', {
        markers: result.markers,
      });
    }
    return { multiHosts: result.multi_hosts || null };
  } catch (renderError) {
    return {
      problem: {
        status: 400,
        payload: { error: `Template render failed: ${renderError.message}` },
      },
    };
  }
};

/**
 * Required-params + pre-flight checks for the single-host create body —
 * runs POST-render, so template-defaulted consoleport/vcpus values refuse
 * honestly instead of poisoning the zone.
 * @param {Object} body - Request body (post-render)
 * @returns {{status: number, payload: Object}|null} Refusal or null
 */
const validateCreateBody = body => {
  const { settings, zones } = body;
  if (!settings?.hostname || !settings?.domain || !zones?.brand) {
    return {
      status: 400,
      payload: {
        error:
          'Missing required parameters: settings.hostname, settings.domain, and zones.brand are required',
      },
    };
  }
  const preflightProblem =
    consoleportRangeError(settings.consoleport) || vcpusCountError(settings.vcpus);
  if (preflightProblem) {
    return { status: 400, payload: { error: preflightProblem } };
  }
  if (!validateZoneName(`${settings.hostname}.${settings.domain}`)) {
    return { status: 400, payload: { error: 'Invalid zone name' } };
  }
  return null;
};

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
 *                           template = clone from settings.box (size = grow-to; absent
 *                           size keeps the template's size; clone_strategy clone|copy) ·
 *                           image = attach an EXISTING zvol by path (never created or
 *                           deleted by the agent) · blank = create a fresh zvol (size
 *                           REQUIRED) · none = diskless (takes no other keys)
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
 *                         enum: [clone, copy]
 *                         default: "clone"
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
/**
 * Validate + name-resolve ONE host of a multi-host create. Refusals return
 * {problem}; success returns the prepared entry.
 * @param {Object} hostBody - Per-machine create body
 * @param {number} index - Position in hosts[] (for error naming)
 * @returns {Promise<Object>} {problem} | {finalZoneName, hostBody, warnings}
 */
const prepareMultiHostEntry = async (hostBody, index) => {
  const label = `multi-host entry ${index + 1}`;
  const { settings, zones } = hostBody;
  if (!settings?.hostname || !settings?.domain || !zones?.brand) {
    return {
      problem: {
        status: 400,
        payload: {
          error: `${label}: settings.hostname, settings.domain, and zones.brand are required`,
        },
      },
    };
  }
  const baseName = `${settings.hostname}.${settings.domain}`;
  if (!validateZoneName(baseName)) {
    return {
      problem: { status: 400, payload: { error: `${label}: invalid zone name ${baseName}` } },
    };
  }
  // Consoleport + vcpus pre-flight (agreed cross-agent strings) — catches
  // the rendered document's values too, since multi-host bodies arrive
  // post-render.
  const preflightProblem =
    consoleportRangeError(settings.consoleport) || vcpusCountError(settings.vcpus);
  if (preflightProblem) {
    return {
      problem: { status: 400, payload: { error: `${label}: ${preflightProblem}` } },
    };
  }
  // Packaged transport + the DRY nic derivation (sync-converged 2026-07-18).
  prepareNetworkSections(hostBody);

  // Typed disk wire — frozen strings, entry-prefixed.
  normalizeDisks(hostBody);
  const diskValidation = validateDisksWire(hostBody);
  if (diskValidation.errors.length > 0) {
    return {
      problem: { status: 400, payload: { error: `${label}: ${diskValidation.errors[0]}` } },
    };
  }
  const imageErrors = await validateDiskImages(hostBody.disks);
  if (imageErrors.length > 0) {
    return {
      problem: { status: 400, payload: { error: `${label}: ${imageErrors[0]}` } },
    };
  }
  const nameResult = await resolveZoneName(baseName, settings);
  if (!nameResult.success) {
    return { problem: { status: nameResult.error.status, payload: nameResult.error } };
  }
  const conflict = await findExistingZoneConflict(nameResult.finalZoneName);
  if (conflict) {
    return { problem: { status: 409, payload: conflict } };
  }
  const boxResolution = await resolveBoxToTemplate(settings, hostBody.disks);
  if (!boxResolution.success) {
    return {
      problem: {
        status: boxResolution.error.status || 400,
        payload: {
          error: `${label}: every template must be local — auto-download is single-host only`,
          details: boxResolution.error,
        },
      },
    };
  }
  hostBody.name = baseName;
  if (boxResolution.template_dataset) {
    hostBody.disks.boot.template_dataset = boxResolution.template_dataset;
  }
  const resourceValidation = await validateZoneCreationResources(hostBody);
  if (!resourceValidation.valid) {
    // The CONVERGED shape (Go parity): the single-host wording, each detail
    // annotated with which host entry (1-based, matching the entry labels)
    // and machine failed — richer than a prefixed message, and details[]
    // has no single message to prefix.
    return {
      problem: {
        status: 400,
        payload: {
          error: 'Insufficient resources',
          details: resourceValidation.errors.map(detail => ({
            ...detail,
            entry: index + 1,
            machine_name: nameResult.finalZoneName,
          })),
        },
      },
    };
  }
  return {
    finalZoneName: nameResult.finalZoneName,
    hostBody,
    warnings: [...resourceValidation.warnings, ...diskValidation.warnings],
  };
};

/**
 * Multi-host create (§5 hosts[]): ONE rendered document → N coordinated
 * machines. Every host validates/conflict-checks BEFORE anything is created
 * (atomic refusal); creation chains in DECLARATION ORDER — machine k+1's
 * first task gates on machine k's last (finalize, or start when
 * start_after_create rides), so join vars written by earlier machines'
 * provisioning hold when later machines come up.
 * @param {Object} req - Request
 * @param {Object} res - Response
 * @param {Array<Object>} hostBodies - Per-machine create bodies
 * @returns {Promise<Object>} Response
 */
const createMultiHostMachines = async (req, res, hostBodies) => {
  try {
    // Phase 1 — every host validates/conflict-checks sequentially BEFORE
    // anything is created (atomic refusal). Sequential promise chain: the
    // reduce pattern the creators use (validation queries must not race).
    const phase1 = await hostBodies.reduce(
      (promise, hostBody, index) =>
        promise.then(async acc => {
          if (acc.problem) {
            return acc;
          }
          const entry = await prepareMultiHostEntry(hostBody, index);
          if (entry.problem) {
            return { ...acc, problem: entry.problem };
          }
          if (acc.seenNames.has(entry.finalZoneName)) {
            return {
              ...acc,
              problem: {
                status: 400,
                payload: {
                  error: `multi-host document names ${entry.finalZoneName} more than once`,
                },
              },
            };
          }
          acc.seenNames.add(entry.finalZoneName);
          acc.prepared.push(entry);
          return acc;
        }),
      Promise.resolve({ prepared: [], seenNames: new Set(), problem: null })
    );
    if (phase1.problem) {
      return res.status(phase1.problem.status).json(phase1.problem.payload);
    }

    // Phase 2 — creation chains in DECLARATION ORDER: machine k+1's first
    // task gates on machine k's last.
    const machines = [];
    const warnings = {};
    await phase1.prepared.reduce(
      (promise, { finalZoneName, hostBody, warnings: hostWarnings }) =>
        promise.then(async previousLast => {
          const parentTask = await Tasks.create({
            zone_name: finalZoneName,
            operation: 'zone_create_orchestration',
            priority: TaskPriority.MEDIUM,
            created_by: req.entity.name,
            metadata: JSON.stringify(hostBody),
            status: 'running',
            started_at: new Date(),
          });
          const { subTasks } = await createZoneCreationSubTasks(
            finalZoneName,
            hostBody,
            parentTask.id,
            previousLast,
            hostBody.start_after_create,
            req.entity.name
          );
          machines.push({
            machine_name: finalZoneName,
            parent_task_id: parentTask.id,
            sub_tasks: subTasks,
          });
          if (hostWarnings?.length > 0) {
            warnings[finalZoneName] = hostWarnings;
          }
          return subTasks.start || subTasks.stage || subTasks.finalize;
        }),
      Promise.resolve(null)
    );

    const response = {
      success: true,
      multi_host: true,
      count: machines.length,
      message: `Multi-host creation queued — ${machines.length} machines in document order`,
      machines,
    };
    if (Object.keys(warnings).length > 0) {
      response.resource_warnings = warnings;
    }
    return res.json(response);
  } catch (error) {
    log.api.error('Multi-host creation failed', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Failed to queue multi-host creation', details: error.message });
  }
};

export const createZone = async (req, res) => {
  try {
    const { problem, multiHosts } = preparePackageDocument(req.body);
    if (problem) {
      return res.status(problem.status).json(problem.payload);
    }
    if (multiHosts) {
      return createMultiHostMachines(req, res, multiHosts);
    }

    // NEW HOSTS.YML STRUCTURE ONLY
    const { settings, start_after_create } = req.body;

    const bodyProblem = validateCreateBody(req.body);
    if (bodyProblem) {
      return res.status(bodyProblem.status).json(bodyProblem.payload);
    }

    // Packaged transport + the DRY nic derivation (sync-converged 2026-07-18).
    prepareNetworkSections(req.body);

    // Typed disk wire (frozen disk spec): normalize the documented default,
    // refuse with the frozen strings, then verify image paths on the host.
    normalizeDisks(req.body);
    const diskValidation = validateDisksWire(req.body);
    if (diskValidation.errors.length > 0) {
      return res.status(400).json({ error: diskValidation.errors[0] });
    }
    const imageErrors = await validateDiskImages(req.body.disks);
    if (imageErrors.length > 0) {
      return res.status(400).json({ error: imageErrors[0] });
    }

    // Build base FQDN: hostname.domain
    const baseName = `${settings.hostname}.${settings.domain}`;

    // Resolve final zone name (applies server_id prefix if configured)
    const nameResult = await resolveZoneName(baseName, settings);
    if (!nameResult.success) {
      return res.status(nameResult.error.status).json(nameResult.error);
    }
    const { finalZoneName } = nameResult;

    const conflict = await findExistingZoneConflict(finalZoneName);
    if (conflict) {
      return res.status(409).json(conflict);
    }

    // Box resolution: convert settings.box reference to template_dataset path
    const boxResolution = await resolveBoxToTemplate(settings, req.body.disks);

    // Ensure metadata.name is set for task executor (base name, not prefixed)
    req.body.name = baseName;

    // Template found locally — enrich the TYPED boot entry (internal key;
    // the wire's type stays the declaration, template_dataset the resolution)
    if (boxResolution.success && boxResolution.template_dataset) {
      req.body.disks.boot.template_dataset = boxResolution.template_dataset;
    }

    // Validate resource availability (storage space) before creating any tasks
    const resourceValidation = await validateZoneCreationResources(req.body);
    if (!resourceValidation.valid) {
      return res.status(400).json({
        error: 'Insufficient resources',
        details: resourceValidation.errors,
      });
    }
    const allWarnings = [...resourceValidation.warnings, ...diskValidation.warnings];

    // Handle missing template with auto-download (typed gate: only a
    // type: template boot entry ever resolves a box, so a 404 here IS the
    // download case)
    if (!boxResolution.success && boxResolution.error.status === 404) {
      const response = await handleAutoDownload(
        finalZoneName,
        req.body,
        settings,
        start_after_create,
        req.entity.name
      );
      if (allWarnings.length > 0) {
        response.resource_warnings = allWarnings;
      }
      return res.json(response);
    }

    // Template missing but cannot auto-download (no box reference)
    if (!boxResolution.success) {
      return res.status(boxResolution.error.status).json(boxResolution.error);
    }

    // Template available - create orchestration with sub-tasks (no download).
    // The orchestration parent is a pure anchor: born running, never
    // dispatched (the queue picks only pending rows); the child rollup
    // drives its state (the Go queue's model).
    const parentTask = await Tasks.create({
      zone_name: finalZoneName,
      operation: 'zone_create_orchestration',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      metadata: JSON.stringify(req.body),
      status: 'running',
      started_at: new Date(),
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

    // Wire status describes the QUEUED WORK (the children) — Go answers the
    // same way; the parent row itself is a running anchor from birth.
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
    if (allWarnings.length > 0) {
      createResponse.resource_warnings = allWarnings;
    }
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
