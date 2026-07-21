import Zones from '../../models/ZoneModel.js';
import { log } from '../../lib/Logger.js';
import { validateZoneName, vcpusCountError } from '../../lib/ZoneValidation.js';
import { validateZoneModificationResources } from '../../lib/ResourceValidation.js';
import { CREDENTIAL_FIELDS, ZONE_ATTR_FIELDS } from './ZoneModification/ZoneModifyConstants.js';
import {
  validateZoneAttrFields,
  applyZoneAttrFields,
  handleResizeDisks,
  validateAddDisksWire,
  applyImmediateFields,
  applyProvisionerImmediate,
  handleGuestAgentField,
  handleTransportFlags,
} from './ZoneModification/ZoneModifyImmediate.js';
import {
  buildImmediateResponse,
  queueInfrastructureChanges,
} from './ZoneModification/ZoneModifyQueue.js';

/**
 * @fileoverview Zone modification controller
 */

/**
 * @swagger
 * /machines/{machineName}:
 *   put:
 *     summary: Modify machine configuration
 *     description: |
 *       Modifies an existing machine's (zone's) configuration. notes/tags and the SSH
 *       credentials family apply immediately (DB only); the provisioner document stores
 *       immediately. Infrastructure changes against a POWERED-OFF zone queue a zonecfg
 *       task; against anything else they ACCRUE into configuration.pending_changes and
 *       the answer is status pending_power_cycle — they apply at the next agent-driven
 *       power cycle (DELETE /machines/{name}/pending-changes cancels,
 *       POST /machines/{name}/pending-changes/apply applies to a powered-off zone).
 *       At least one modification field must be provided.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine to modify
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ram:
 *                 type: string
 *                 description: Memory allocation
 *                 example: "4G"
 *               vcpus:
 *                 type: string
 *                 description: Number of virtual CPUs
 *                 example: "4"
 *               bootrom:
 *                 type: string
 *                 description: Boot ROM firmware (agent creates default to BHYVE_RELEASE — UEFI; the _CSM builds are legacy BIOS boot)
 *                 example: "BHYVE_RELEASE"
 *               hostbridge:
 *                 type: string
 *                 description: Host bridge emulation
 *                 example: "i440fx"
 *               diskif:
 *                 type: string
 *                 description: Disk interface type
 *                 example: "virtio"
 *               netif:
 *                 type: string
 *                 description: Network interface type
 *                 example: "virtio"
 *               os_type:
 *                 type: string
 *                 description: Guest OS type
 *                 example: "generic"
 *               vnc:
 *                 type: string
 *                 description: VNC console setting
 *                 example: "on"
 *               acpi:
 *                 type: string
 *                 description: ACPI support
 *                 example: "on"
 *               xhci:
 *                 type: string
 *                 description: xHCI USB controller
 *                 example: "on"
 *               uefivars:
 *                 type: string
 *                 description: Persistent UEFI variables (zadm bool attr, brand default on)
 *                 example: "on"
 *               rng:
 *                 type: string
 *                 description: virtio RNG device (zadm bool attr, brand default off)
 *                 example: "off"
 *               boot_priority:
 *                 type: integer
 *                 nullable: true
 *                 minimum: 1
 *                 maximum: 100
 *                 description: |
 *                   Orchestration boot/shutdown priority (custom zonecfg attr; default 95
 *                   when unset). Higher starts earlier and stops later. Applies IMMEDIATELY
 *                   through zonecfg's offline store — no task, no restart (orchestration
 *                   reads it at host power events). null clears back to the default.
 *                 example: 50
 *               consoleport:
 *                 type: integer
 *                 nullable: true
 *                 minimum: 1025
 *                 maximum: 65535
 *                 description: |
 *                   Pinned noVNC web-console port (custom zonecfg attr). Applies IMMEDIATELY;
 *                   takes effect at the next VNC session start. null clears — the zone goes
 *                   back to the agent's dynamic port pool (vnc.web_port_range_*).
 *                 example: 6001
 *               consolehost:
 *                 type: string
 *                 nullable: true
 *                 description: |
 *                   noVNC web-console bind address (custom zonecfg attr; unset = 0.0.0.0).
 *                   Applies IMMEDIATELY; takes effect at the next VNC session start.
 *                 example: "127.0.0.1"
 *               bootorder:
 *                 type: string
 *                 description: |
 *                   bhyve boot order — compact `cd`/`dc` (the ONLY compact forms) or
 *                   comma-separated device tokens: bootdisk, disk[N], cdrom[N],
 *                   net[N][=pxe|http], path[N], boot[N], shell (zadm bhyveBootDev
 *                   grammar). Passes to zonecfg verbatim.
 *                 example: "cdrom0,bootdisk"
 *               bootnext:
 *                 type: string
 *                 description: One-shot boot device for the NEXT boot only (same vocabulary)
 *                 example: "cdrom0"
 *               autoboot:
 *                 type: boolean
 *                 description: Auto-boot zone on system startup
 *               cpu_configuration:
 *                 type: string
 *                 enum: [simple, complex]
 *                 description: "Change CPU topology mode"
 *                 example: "complex"
 *               complex_cpu_conf:
 *                 type: array
 *                 description: "New CPU topology (required if cpu_configuration is 'complex')"
 *                 items:
 *                   type: object
 *                   required: [sockets, cores, threads]
 *                   properties:
 *                     sockets:
 *                       type: integer
 *                       minimum: 1
 *                       maximum: 16
 *                     cores:
 *                       type: integer
 *                       minimum: 1
 *                       maximum: 32
 *                     threads:
 *                       type: integer
 *                       minimum: 1
 *                       maximum: 2
 *                 example:
 *                   - sockets: 2
 *                     cores: 2
 *                     threads: 1
 *               add_nics:
 *                 type: array
 *                 description: |
 *                   NICs to add. A bare {physical} with no global_nic attaches a
 *                   dedicated physical/pre-created link as-is. props entries become
 *                   zonecfg net PROPERTIES (bhyve netprop names — promiscphys,
 *                   promiscrxonly, promiscsap, promiscmulti, vqsize, mtu,
 *                   feature_mask, backend, netif).
 *                 items:
 *                   type: object
 *                   properties:
 *                     physical:
 *                       type: string
 *                       description: VNIC or physical link name
 *                       example: "vnic1"
 *                     global_nic:
 *                       type: string
 *                       description: Bridge/physical NIC for on-demand creation (omit for dedicated physical links)
 *                       example: "igb0"
 *                     vlan_id:
 *                       type: integer
 *                     mac_addr:
 *                       type: string
 *                     allowed_address:
 *                       type: string
 *                     address:
 *                       type: string
 *                       description: zonecfg net address property
 *                     defrouter:
 *                       type: string
 *                       description: zonecfg net defrouter property
 *                     props:
 *                       type: object
 *                       description: net resource properties (name → value)
 *                       example: { "promiscphys": "on" }
 *               remove_nics:
 *                 type: array
 *                 description: VNIC names to remove
 *                 items:
 *                   type: string
 *                   example: "vnic0"
 *               update_nics:
 *                 type: array
 *                 description: |
 *                   Edit existing net resources in place, selected by physical.
 *                   Provided keys SET the property; omitted keys keep their value.
 *                   Clearing a property is not part of this wire — detach + re-add.
 *                 items:
 *                   type: object
 *                   required: [physical]
 *                   properties:
 *                     physical:
 *                       type: string
 *                       description: The net resource's physical VNIC name (selector)
 *                       example: "vnic1"
 *                     global_nic:
 *                       type: string
 *                       example: "igb0"
 *                     vlan_id:
 *                       type: integer
 *                       example: 20
 *                     mac_addr:
 *                       type: string
 *                       example: "02:08:20:ab:cd:ef"
 *                     allowed_address:
 *                       type: string
 *                       example: "10.0.0.15/24"
 *                     address:
 *                       type: string
 *                       description: zonecfg net address property
 *                     defrouter:
 *                       type: string
 *                       description: zonecfg net defrouter property
 *                     props:
 *                       type: object
 *                       description: net properties to REPLACE (current pair removed, new pair added)
 *                       example: { "promiscphys": "on" }
 *                     remove_on_completion:
 *                       type: boolean
 *                       description: |
 *                         The provisioning-transport removal flag (converged wire,
 *                         2026-07-18) — a DOCUMENT-side edit applied IMMEDIATELY: the
 *                         agent maps this NIC to its paired networks[] entry (same
 *                         index rule as knob_current) and records the flag; nothing
 *                         queues, nothing accrues. Absent flag = this agent's default:
 *                         REMOVE after the whole-walk stamp (knob_defaults
 *                         'transport.remove_on_completion'). An entry carrying ONLY
 *                         this key + physical answers status completed with
 *                         transport_flags_applied[].
 *               add_disks:
 *                 type: array
 *                 description: |
 *                   Disks to add — the frozen TYPED entries (the create wire's
 *                   additional-disk vocabulary verbatim, converged 2026-07-18):
 *                   every entry DECLARES its type; refusals answer AT the PUT
 *                   with the add_disks[<n>] prefix (1-based) on both the queue
 *                   and accrue paths, and the executor re-enforces.
 *                 items:
 *                   type: object
 *                   required: [type]
 *                   properties:
 *                     type:
 *                       type: string
 *                       enum: [image, blank]
 *                       description: blank = create a fresh zvol (size REQUIRED, stamped ours) · image = attach an EXISTING zvol by path (never created, never stamped)
 *                     size:
 *                       type: string
 *                       description: blank REQUIRES it — no default
 *                       example: "100G"
 *                     sparse:
 *                       type: boolean
 *                       default: true
 *                     volume_name:
 *                       type: string
 *                       description: blank only (defaults diskN)
 *                       example: "extra"
 *                     pool:
 *                       type: string
 *                       default: "rpool"
 *                     dataset:
 *                       type: string
 *                       default: "zones"
 *                     path:
 *                       type: string
 *                       description: image only — the existing zvol's dataset path
 *                       example: "rpool/vms/old-server/data"
 *                     force:
 *                       type: boolean
 *                       default: false
 *                       description: image only — attach even when another machine references the zvol
 *               resize_disks:
 *                 type: array
 *                 description: |
 *                   Resize disk zvols, selected by disk name (bootdisk, disk0, …). Applied
 *                   IMMEDIATELY — this never accrues and never queues a task.
 *
 *                   GROW: lands live. virtio-blk and nvme register a blockif resize
 *                   callback, so the guest sees the new capacity at once (verified on a
 *                   running machine). ahci/ahci-hd/ide bake their capacity into the
 *                   IDENTIFY data at attach and never refresh it, so for those the answer
 *                   carries `requires_restart: true` on that disk. The ONLY gate on a grow
 *                   is capacity: a grow the pool cannot back is refused (400) because it
 *                   would over-provision the pool into a guest-corrupting ENOSPC —
 *                   `allow_overprovision: true` overrides for deliberate thin provisioning.
 *
 *                   SHRINK: gated hard. It TRUNCATES the volume — everything past the new
 *                   end is destroyed and the guest filesystem will most likely not boot.
 *                   Requires `allow_shrink: true` AND a powered-off machine; either
 *                   missing is a 400 naming the reason.
 *
 *                   The answer carries `resized_disks[]` ({name, dataset, diskif,
 *                   previous_bytes, resized_to, shrunk?, requires_restart}).
 *                 items:
 *                   type: object
 *                   required: [name, size]
 *                   properties:
 *                     name:
 *                       type: string
 *                       example: "disk0"
 *                     size:
 *                       type: string
 *                       example: "100G"
 *                     allow_shrink:
 *                       type: boolean
 *                       default: false
 *                       description: Required to shrink. DESTRUCTIVE — truncates the volume. Also requires the machine to be powered off.
 *                     allow_overprovision:
 *                       type: boolean
 *                       default: false
 *                       description: Allow a grow the pool cannot currently back (deliberate thin provisioning).
 *               remove_disks:
 *                 type: array
 *                 description: Disk attribute names to remove (e.g. "disk0")
 *                 items:
 *                   type: string
 *                   example: "disk0"
 *               add_cdroms:
 *                 type: array
 *                 description: ISO images to attach — raw path OR a cached-ISO filename resolved through the artifact registry (one of the two per entry)
 *                 items:
 *                   type: object
 *                   properties:
 *                     path:
 *                       type: string
 *                       example: "/iso/install.iso"
 *                     iso:
 *                       type: string
 *                       description: Cached ISO filename from the artifact registry (GET /artifacts/iso)
 *                       example: "debian-12.5.0-amd64-netinst.iso"
 *               remove_cdroms:
 *                 type: array
 *                 description: CDROM attribute names to remove (e.g. "cdrom0")
 *                 items:
 *                   type: string
 *                   example: "cdrom0"
 *               add_filesystems:
 *                 type: array
 *                 description: Filesystem mounts to add (generic lofs shares into the zone)
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
 *               remove_filesystems:
 *                 type: array
 *                 description: Filesystem mounts to remove, by in-zone dir
 *                 items:
 *                   type: string
 *                   example: "/data/wipelogs"
 *               capped_cpu:
 *                 type: object
 *                 nullable: true
 *                 description: CPU cap (zonecfg capped-cpu) — object REPLACES the resource, null REMOVES it
 *                 properties:
 *                   ncpus:
 *                     type: number
 *                     example: 2.5
 *               capped_memory:
 *                 type: object
 *                 nullable: true
 *                 description: Memory caps (zonecfg capped-memory) — provided keys set; object replaces, null removes
 *                 properties:
 *                   physical: { type: string, example: "4g" }
 *                   swap: { type: string, example: "8g" }
 *                   locked: { type: string, example: "1g" }
 *               dedicated_cpu:
 *                 type: object
 *                 nullable: true
 *                 description: Dedicated CPU set (zonecfg dedicated-cpu) — object replaces, null removes
 *                 properties:
 *                   ncpus: { type: string, example: "2-4" }
 *                   importance: { type: integer, example: 10 }
 *               rctls:
 *                 type: array
 *                 description: Resource controls to set (replace-by-name) — priv defaults privileged, action defaults deny
 *                 items:
 *                   type: object
 *                   required: [name, limit]
 *                   properties:
 *                     name: { type: string, example: "zone.max-lwps" }
 *                     limit: { type: integer, example: 5000 }
 *                     priv: { type: string, example: "privileged" }
 *                     action: { type: string, example: "deny" }
 *               remove_rctls:
 *                 type: array
 *                 description: Resource-control names to remove
 *                 items:
 *                   type: string
 *                   example: "zone.max-lwps"
 *               security_flags:
 *                 type: object
 *                 nullable: true
 *                 description: Process security flags (zonecfg security-flags) — object replaces, null removes
 *                 properties:
 *                   default: { type: string, example: "aslr" }
 *                   lower: { type: string, example: "none" }
 *                   upper: { type: string, example: "all" }
 *               admins:
 *                 type: array
 *                 description: Delegated administration entries (zonecfg admin, replace-by-user)
 *                 items:
 *                   type: object
 *                   required: [user, auths]
 *                   properties:
 *                     user: { type: string, example: "jdoe" }
 *                     auths: { type: string, example: "login,manage" }
 *               remove_admins:
 *                 type: array
 *                 description: Delegated-admin users to remove
 *                 items:
 *                   type: string
 *                   example: "jdoe"
 *               fs_allowed:
 *                 type: string
 *                 nullable: true
 *                 description: Comma-separated filesystem types the zone may mount (zonecfg fs-allowed); null/'' clears
 *                 example: "ufs,pcfs"
 *               virtfs:
 *                 type: array
 *                 description: |
 *                   VirtFS (Virtio 9p) shares — the array REPLACES the whole set
 *                   (numbered virtfsN attrs, list order; [] clears). The shared
 *                   path must also be mapped into the zone (delegated dataset or
 *                   lofs mount — bhyve(7) EXAMPLES).
 *                 items:
 *                   type: object
 *                   required: [name, path]
 *                   properties:
 *                     name: { type: string, example: "datavol" }
 *                     path: { type: string, example: "/datavol" }
 *                     ro: { type: boolean, default: false }
 *               ppt:
 *                 type: array
 *                 description: |
 *                   PCI pass-through devices — the array REPLACES the whole set
 *                   ([] clears): each entry writes the pptN attr plus its
 *                   /dev/pptN device block. Devices must already be bound to the
 *                   ppt driver (pptadm list -a).
 *                 items:
 *                   type: object
 *                   required: [device]
 *                   properties:
 *                     device: { type: string, example: "ppt0" }
 *                     state: { type: string, default: "on", example: "slot3", description: "on | off | slot0-7" }
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
 *                 example: ["web", "production"]
 *               cloud_init:
 *                 type: object
 *                 description: Cloud-init attributes to set or update
 *                 properties:
 *                   enabled:
 *                     type: string
 *                     example: "on"
 *                   dns_domain:
 *                     type: string
 *                     example: "example.com"
 *                   password:
 *                     type: string
 *                   resolvers:
 *                     type: string
 *                     example: "8.8.8.8,8.8.4.4"
 *                   sshkey:
 *                     type: string
 *               provisioner:
 *                 type: object
 *                 description: Provisioner configuration object
 *                 example: { "type": "ansible", "playbook": "site.yml" }
 *               guest_agent:
 *                 type: boolean
 *                 description: |
 *                   Wire (true) or remove (false) the QEMU guest-agent virtio-console
 *                   channel. Applies synchronously through zonecfg's offline store
 *                   regardless of power state — the answer carries requires_restart:
 *                   true and the change reaches the guest at its next boot. Gated by
 *                   the guest_agent.enabled setting. Current state rides GET
 *                   /machines/{machineName} as knob_current.guest_agent.
 *               vagrant_user:
 *                 type: string
 *                 nullable: true
 *                 description: SSH username (merges into configuration.settings immediately; null or empty clears)
 *               vagrant_user_pass:
 *                 type: string
 *                 nullable: true
 *                 description: SSH password (DB-immediate; never lands in task metadata)
 *               vagrant_user_private_key_path:
 *                 type: string
 *                 nullable: true
 *                 description: SSH private key path, absolute or relative to the provisioning dataset (DB-immediate)
 *           examples:
 *             change_resources:
 *               summary: Change RAM and vCPUs
 *               value:
 *                 ram: "4G"
 *                 vcpus: "4"
 *             add_nic:
 *               summary: Add a NIC
 *               value:
 *                 add_nics:
 *                   - physical: "vnic1"
 *                     global_nic: "igb0"
 *             add_disk:
 *               summary: Add a new disk (typed wire)
 *               value:
 *                 add_disks:
 *                   - type: "blank"
 *                     pool: "rpool"
 *                     dataset: "zones"
 *                     volume_name: "extra"
 *                     size: "100G"
 *     responses:
 *       200:
 *         description: Modification task queued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 task_id:
 *                   type: string
 *                   format: uuid
 *                 machine_name:
 *                   type: string
 *                   example: "web-server-01"
 *                 operation:
 *                   type: string
 *                   example: "zone_modify"
 *                 status:
 *                   type: string
 *                   example: "pending"
 *                 message:
 *                   type: string
 *                   example: "Modification queued. Changes will take effect on next zone boot."
 *                 requires_restart:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Invalid parameters or no changes specified
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to queue modification task
 */
export const modifyZone = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    const changeFields = [
      'ram',
      'vcpus',
      'bootrom',
      'hostbridge',
      'diskif',
      'netif',
      'os_type',
      'vnc',
      'acpi',
      'xhci',
      'uefivars',
      'rng',
      'bootorder',
      'bootnext',
      'autoboot',
      'cpu_configuration',
      'complex_cpu_conf',
      'add_nics',
      'remove_nics',
      'update_nics',
      'add_disks',
      'resize_disks',
      'remove_disks',
      'add_cdroms',
      'remove_cdroms',
      'add_filesystems',
      'remove_filesystems',
      'capped_cpu',
      'capped_memory',
      'dedicated_cpu',
      'rctls',
      'remove_rctls',
      'security_flags',
      'admins',
      'remove_admins',
      'fs_allowed',
      'virtfs',
      'ppt',
      'cloud_init',
      'provisioner',
      'notes',
      'tags',
      'snapshots',
      'guest_agent',
      ...CREDENTIAL_FIELDS,
      ...ZONE_ATTR_FIELDS,
    ];
    const hasChanges = changeFields.some(field => req.body[field] !== undefined);

    if (!hasChanges) {
      return res.status(400).json({ error: 'No modification fields specified' });
    }

    if (!validateZoneAttrFields(req.body, res)) {
      return undefined;
    }

    const vcpusProblem = vcpusCountError(req.body.vcpus);
    if (vcpusProblem) {
      return res.status(400).json({ error: vcpusProblem });
    }

    const addDiskWarnings = await validateAddDisksWire(req, res);
    if (addDiskWarnings === null) {
      return undefined;
    }

    const guestAgent = await handleGuestAgentField(req, res, zoneName);
    if (guestAgent.response) {
      return guestAgent.response;
    }
    const guestAgentApplied = guestAgent.applied;

    let resized = null;
    if (req.body.resize_disks !== undefined) {
      const resize = await handleResizeDisks(res, zoneName, req.body.resize_disks);
      if (resize.response) {
        return resize.response;
      }
      resized = resize.applied;
    }

    await applyImmediateFields(zone, zoneName, req.body);
    const appliedAttrs = await applyZoneAttrFields(zoneName, req.body);

    const transportFlags = await handleTransportFlags(req, res, zoneName, changeFields);
    if (transportFlags === null) {
      return undefined;
    }

    const dbOnlyFields = [
      'notes',
      'tags',
      'snapshots',
      'guest_agent',
      'resize_disks',
      ...CREDENTIAL_FIELDS,
      ...ZONE_ATTR_FIELDS,
    ];
    const hasDbOnlyChanges = dbOnlyFields.some(f => req.body[f] !== undefined);
    const hasOtherChanges = changeFields
      .filter(f => !dbOnlyFields.includes(f))
      .some(field => req.body[field] !== undefined);
    if (hasDbOnlyChanges && !hasOtherChanges) {
      return res.json(buildImmediateResponse(zoneName, guestAgentApplied, resized, appliedAttrs));
    }

    const provisionerOnly = await applyProvisionerImmediate(zone, zoneName, req.body, changeFields);
    if (provisionerOnly) {
      return res.json(provisionerOnly);
    }

    const resourceValidation = await validateZoneModificationResources(req.body, zoneName);
    if (!resourceValidation.valid) {
      return res.status(400).json({
        error: 'Insufficient resources',
        details: resourceValidation.errors,
      });
    }

    return await queueInfrastructureChanges(req, res, zoneName, {
      changeFields,
      warnings: [...resourceValidation.warnings, ...addDiskWarnings],
      transportFlags,
      guestAgentApplied,
      resized,
      appliedAttrs,
    });
  } catch (error) {
    log.database.error('Database error modifying zone task', {
      error: error.message,
      zone_name: req.params.machineName,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue zone modification task' });
  }
};
