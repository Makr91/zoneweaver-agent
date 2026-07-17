import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import { validateZoneName } from '../../lib/ZoneValidation.js';
import { validateZoneModificationResources } from '../../lib/ResourceValidation.js';
import {
  mergePendingChanges,
  clearPendingChanges,
  mergeSettingsKeys,
  setSnapshotPolicy,
  readZonecfgAttr,
  getZoneConfig,
  parseConfiguration,
} from '../../lib/ZoneConfigUtils.js';
import { resizeMachineDisks } from '../../lib/MachineDiskResize.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { isGuestAgentEnabled } from '../../lib/QemuGuestAgent.js';
import { applyGuestAgentToggle } from '../GuestAgentController.js';
import { getSystemZoneStatus } from './ZoneQueryController.js';

/**
 * @fileoverview Zone modification controller
 */

const CREDENTIAL_FIELDS = ['vagrant_user', 'vagrant_user_pass', 'vagrant_user_private_key_path'];

// Agent-owned custom zonecfg attrs (the boot_priority pattern): the value
// rides the zone config itself — it exports/migrates with the zone — and no
// boot path consumes it, so writes apply SYNCHRONOUSLY through zonecfg's
// offline store (never task/accrue). Readers look at the config fresh:
// orchestration reads boot_priority at host power events, vnc/start reads
// consoleport/consolehost when it spawns `zadm vnc`. null/'' removes the attr.
const ZONE_ATTR_FIELDS = ['boot_priority', 'consoleport', 'consolehost'];

/**
 * Validate the direct-attr fields; answers the 400 (and returns false) on the
 * first invalid value, so callers just bail.
 */
const validateZoneAttrFields = (body, res) => {
  const numericRules = [
    ['boot_priority', 1, 100, 'boot_priority must be an integer 1-100 (null clears; default 95)'],
    [
      'consoleport',
      1025,
      65535,
      'consoleport must be an integer 1025-65535 (null clears — back to the dynamic pool)',
    ],
  ];
  for (const [field, min, max, message] of numericRules) {
    const value = body[field];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    const num = Number(value);
    if (!Number.isInteger(num) || num < min || num > max) {
      res.status(400).json({ error: message });
      return false;
    }
  }
  return true;
};

/**
 * Apply the direct-attr fields present in the body via ONE batched zonecfg
 * transaction (select-or-add per attr, remove on null/''), through the
 * offline store. Returns the applied field names.
 * @throws {Error} When the zonecfg apply fails
 */
const applyZoneAttrFields = async (zoneName, body) => {
  const fields = ZONE_ATTR_FIELDS.filter(field => body[field] !== undefined);
  if (fields.length === 0) {
    return [];
  }
  const reads = await Promise.all(fields.map(field => readZonecfgAttr(zoneName, field)));
  const commands = fields
    .map((field, i) => {
      const raw = body[field];
      const value = raw === null || raw === '' ? null : String(raw);
      const { exists } = reads[i];
      if (value === null) {
        return exists ? `remove attr name=${field};` : null;
      }
      return exists
        ? `select attr name=${field}; set value=\\"${value}\\"; end;`
        : `add attr; set name=${field}; set value=\\"${value}\\"; set type=string; end;`;
    })
    .filter(Boolean);
  if (commands.length > 0) {
    const result = await executeCommand(`pfexec zonecfg -z ${zoneName} "${commands.join(' ')}"`);
    if (!result.success) {
      throw new Error(`Failed to apply ${fields.join(', ')}: ${result.error}`);
    }
  }
  return fields;
};

const STOPPED_STATUSES = ['configured', 'incomplete', 'installed', 'down', 'not_found'];

/**
 * resize_disks applies IMMEDIATELY — it never accrues (Mark's ruling: gate the
 * truncate, ungate the grow). A grow lands live: virtio-blk and nvme register a
 * blockif resize callback and the guest sees the new capacity at once; ahci does
 * not, so the answer carries requires_restart for those. A shrink is refused
 * unless it is asked for explicitly AND the machine is powered off.
 * @param {import('express').Response} res - Response
 * @param {string} zoneName - Zone name
 * @param {Array} entries - resize_disks entries
 * @returns {Promise<{applied?: Object, response?: object}>}
 */
const handleResizeDisks = async (res, zoneName, entries) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { response: res.status(400).json({ error: 'resize_disks must be a non-empty array' }) };
  }
  const [zoneConfig, currentStatus] = await Promise.all([
    getZoneConfig(zoneName),
    getSystemZoneStatus(zoneName),
  ]);
  try {
    const applied = await resizeMachineDisks({
      zoneName,
      zoneConfig,
      entries,
      poweredOff: STOPPED_STATUSES.includes(currentStatus),
    });
    return { applied };
  } catch (error) {
    // Every refusal here is a caller error with an actionable message
    // (shrink without the flag, shrink while running, grow the pool can't back).
    return { response: res.status(400).json({ error: error.message }) };
  }
};

const parsePendingSet = zone => parseConfiguration(zone).pending_changes || {};

const queueModifyTask = (zoneName, metadata, createdBy) =>
  Tasks.create({
    zone_name: zoneName,
    operation: 'zone_modify',
    priority: TaskPriority.MEDIUM,
    created_by: createdBy,
    metadata: JSON.stringify(metadata),
    status: 'pending',
  });

const applyImmediateFields = async (zone, zoneName, body) => {
  if (body.notes !== undefined) {
    await zone.update({ notes: body.notes || null });
  }
  if (body.tags !== undefined) {
    await zone.update({ tags: Array.isArray(body.tags) ? body.tags : null });
  }
  if (body.snapshots !== undefined) {
    await setSnapshotPolicy(
      zoneName,
      body.snapshots && body.snapshots.type ? body.snapshots : null
    );
  }
  const credentialUpdates = {};
  for (const field of CREDENTIAL_FIELDS) {
    if (body[field] !== undefined) {
      credentialUpdates[field] = body[field];
    }
  }
  if (Object.keys(credentialUpdates).length > 0) {
    await mergeSettingsKeys(zoneName, credentialUpdates);
  }
};

/**
 * Store the provisioner config immediately (DB only) so the provision endpoint
 * sees it without waiting for the task. Returns the completed response object
 * when provisioner is the ONLY change (caller answers it), or null to continue
 * the normal modify flow.
 * @param {import('../../models/ZoneModel.js').default} zone - Zone record
 * @param {string} zoneName - Zone name
 * @param {Object} body - Request body
 * @param {string[]} changeFields - The recognized change fields
 * @returns {Promise<Object|null>}
 */
const applyProvisionerImmediate = async (zone, zoneName, body, changeFields) => {
  if (!body.provisioner) {
    return null;
  }
  const currentConfig = parseConfiguration(zone);
  await zone.update({ configuration: { ...currentConfig, provisioner: body.provisioner } });

  const otherChanges = changeFields
    .filter(f => f !== 'provisioner')
    .some(field => body[field] !== undefined);
  if (otherChanges) {
    return null;
  }
  return {
    success: true,
    machine_name: zoneName,
    operation: 'zone_modify',
    status: 'completed',
    message: 'Provisioner configuration updated successfully.',
    requires_restart: false,
  };
};

/**
 * Build the `status: completed` answer for a PUT that changed ONLY
 * immediately-applied fields (nothing queued, nothing accrued). Folds in
 * whatever the guest-agent toggle, resize, and attr writes actually did.
 * @param {string} zoneName - Zone name
 * @param {boolean} guestAgentApplied - Whether the guest-agent toggle changed state
 * @param {Object|null} resized - resize_disks result, or null
 * @param {string[]} appliedAttrs - Direct-attr fields written
 * @returns {Object} The response body
 */
const buildImmediateResponse = (zoneName, guestAgentApplied, resized, appliedAttrs) => {
  const messages = [];
  if (guestAgentApplied) {
    messages.push('The guest-agent channel change applies at the next machine boot.');
  }
  if (resized) {
    messages.push(
      resized.requires_restart
        ? 'Disks resized — this machine runs an ahci/ide backend, which reads its capacity only at attach, so the guest sees the new size after a power cycle.'
        : 'Disks resized — the guest sees the new size immediately.'
    );
  }
  const response = {
    success: true,
    machine_name: zoneName,
    operation: 'zone_modify',
    status: 'completed',
    message: messages.length > 0 ? messages.join(' ') : 'Zone metadata updated successfully.',
    requires_restart: guestAgentApplied || Boolean(resized?.requires_restart),
  };
  if (appliedAttrs.length > 0) {
    response.applied_attrs = appliedAttrs;
  }
  if (resized) {
    response.resized_disks = resized.results;
  }
  return response;
};

/**
 * Fold the immediately-applied results (guest-agent toggle, resize, direct
 * attrs) into a response that is really ABOUT the accrued/queued
 * infrastructure changes. Without this, a PUT that both resizes a disk AND
 * changes ram answers the pending/queued body and never mentions that the disk
 * was resized — the resize happened, the caller was not told.
 * @param {Object} response - The accrue or queue response (mutated + returned)
 * @param {boolean} guestAgentApplied - Whether the guest-agent toggle changed state
 * @param {Object|null} resized - resize_disks result, or null
 * @param {string[]} appliedAttrs - Direct-attr fields written
 * @returns {Object} The same response, with the immediate side-effects folded in
 */
const decorateWithImmediate = (response, guestAgentApplied, resized, appliedAttrs) => {
  if (appliedAttrs.length > 0) {
    response.applied_attrs = appliedAttrs;
  }
  if (resized) {
    response.resized_disks = resized.results;
    response.message = `${response.message} Disks were also resized immediately${
      resized.requires_restart ? ' (guest sees new size after a power cycle on ahci/ide)' : ''
    }.`;
  }
  if (guestAgentApplied) {
    response.message = `${response.message} The guest-agent channel change applies at the next boot.`;
  }
  return response;
};

const extractInfrastructureBody = (body, changeFields) => {
  const infrastructure = {};
  const excluded = [
    'provisioner',
    'notes',
    'tags',
    'snapshots',
    'guest_agent',
    // Applied immediately in the controller — never accrued, never queued.
    'resize_disks',
    ...CREDENTIAL_FIELDS,
    ...ZONE_ATTR_FIELDS,
  ];
  for (const [key, value] of Object.entries(body)) {
    if (excluded.includes(key) || !changeFields.includes(key)) {
      continue;
    }
    infrastructure[key] = value;
  }
  return infrastructure;
};

/**
 * Handle the guest_agent toggle field (shared contract with the Go agent):
 * applied SYNCHRONOUSLY through zonecfg's offline store regardless of power
 * state — never accrues, never queues; the caller's answer carries
 * requires_restart. Gate/validation problems answer the request here.
 * @param {import('express').Request} req - Request
 * @param {import('express').Response} res - Response
 * @param {string} zoneName - Zone name
 * @returns {Promise<{applied: boolean, response?: object}>}
 */
const handleGuestAgentField = async (req, res, zoneName) => {
  if (req.body.guest_agent === undefined) {
    return { applied: false };
  }
  if (!isGuestAgentEnabled()) {
    return {
      applied: false,
      response: res.status(503).json({ error: 'Guest agent channel is disabled' }),
    };
  }
  if (typeof req.body.guest_agent !== 'boolean') {
    return {
      applied: false,
      response: res.status(400).json({ error: 'guest_agent must be a boolean' }),
    };
  }
  await applyGuestAgentToggle(zoneName, req.body.guest_agent);
  return { applied: true };
};

/**
 * The accrue-changes contract (shared with the Go agent): against a zone that
 * is not powered off, infrastructure changes ACCRUE into
 * configuration.pending_changes and apply at the next agent-driven power
 * cycle. Answers the pending_power_cycle payload, or null to queue normally.
 */
const maybeAccrueChanges = async (zoneName, infrastructureBody, warnings) => {
  if (Object.keys(infrastructureBody).length === 0) {
    return null;
  }
  const currentStatus = await getSystemZoneStatus(zoneName);
  if (STOPPED_STATUSES.includes(currentStatus)) {
    return null;
  }
  const merged = await mergePendingChanges(zoneName, infrastructureBody);
  const response = {
    success: true,
    machine_name: zoneName,
    operation: 'zone_modify',
    status: 'pending_power_cycle',
    requires_restart: true,
    pending_changes: merged,
    message:
      'Machine is not powered off — changes stored and will apply at the next agent-driven power cycle (stop, start, or restart). DELETE /machines/{name}/pending-changes cancels them.',
  };
  if (warnings.length > 0) {
    response.resource_warnings = warnings;
  }
  return response;
};

/**
 * Queue a zone_modify task carrying the accrued pending set (the accrue
 * contract's apply half; _apply_pending makes the executor clear it on
 * success). Null when nothing is pending or queueing failed.
 */
export const queuePendingApply = async (zone, createdBy) => {
  const pending = parsePendingSet(zone);
  if (Object.keys(pending).length === 0) {
    return null;
  }
  try {
    return await queueModifyTask(zone.name, { ...pending, _apply_pending: true }, createdBy);
  } catch (error) {
    log.database.error('Failed to queue pending-changes apply', {
      zone_name: zone.name,
      error: error.message,
    });
    return null;
  }
};

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
 *                 description: Boot ROM firmware
 *                 example: "BHYVE_RELEASE_CSM"
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
 *               add_disks:
 *                 type: array
 *                 description: Disks to add (new zvols or existing datasets)
 *                 items:
 *                   type: object
 *                   properties:
 *                     create_new:
 *                       type: boolean
 *                     existing_dataset:
 *                       type: string
 *                     pool:
 *                       type: string
 *                       example: "rpool"
 *                     dataset:
 *                       type: string
 *                       example: "zones"
 *                     volume_name:
 *                       type: string
 *                       example: "extra"
 *                     size:
 *                       type: string
 *                       example: "100G"
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
 *               summary: Add a new disk
 *               value:
 *                 add_disks:
 *                   - create_new: true
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

    // Check zone exists in DB
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    // Validate that at least one change field is present
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

    // Immediately-applied fields: nothing queues, nothing accrues.
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

    // Provisioner config stores immediately (DB only) so the provision
    // endpoint sees it without waiting for the task. Answers the completed
    // response when provisioner is the ONLY change, else null to continue.
    const provisionerOnly = await applyProvisionerImmediate(zone, zoneName, req.body, changeFields);
    if (provisionerOnly) {
      return res.json(provisionerOnly);
    }

    // Validate resource availability for modifications (e.g., add_disks)
    const resourceValidation = await validateZoneModificationResources(req.body, zoneName);
    if (!resourceValidation.valid) {
      return res.status(400).json({
        error: 'Insufficient resources',
        details: resourceValidation.errors,
      });
    }

    const infrastructureBody = extractInfrastructureBody(req.body, changeFields);
    const pendingResponse = await maybeAccrueChanges(
      zoneName,
      infrastructureBody,
      resourceValidation.warnings
    );
    if (pendingResponse) {
      return res.json(
        decorateWithImmediate(pendingResponse, guestAgentApplied, resized, appliedAttrs)
      );
    }

    // Create the zone_modify task
    const modifyTask = await queueModifyTask(zoneName, infrastructureBody, req.entity.name);

    const modifyResponse = {
      success: true,
      task_id: modifyTask.id,
      machine_name: zoneName,
      operation: 'zone_modify',
      status: 'pending',
      message: 'Modification queued. Changes will take effect on next zone boot.',
      requires_restart: true,
    };
    if (resourceValidation.warnings.length > 0) {
      modifyResponse.resource_warnings = resourceValidation.warnings;
    }
    return res.json(
      decorateWithImmediate(modifyResponse, guestAgentApplied, resized, appliedAttrs)
    );
  } catch (error) {
    log.database.error('Database error modifying zone task', {
      error: error.message,
      zone_name: req.params.machineName,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue zone modification task' });
  }
};

/**
 * @swagger
 * /machines/{machineName}/pending-changes:
 *   delete:
 *     summary: Cancel the machine's accrued pending changes
 *     description: Clears the set a PUT against a non-powered-off machine stored.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Pending changes cleared
 *       404:
 *         description: Machine not found
 */
export const clearZonePendingChanges = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;
    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Machine not found' });
    }
    const clearedKeys = (await clearPendingChanges(zoneName)) || [];
    log.api.info('Pending changes cleared', {
      zone_name: zoneName,
      keys: clearedKeys.length,
      user: req.entity.name,
    });
    return res.json({
      success: true,
      machine_name: zoneName,
      cleared_keys: clearedKeys,
      message: 'Pending changes cleared',
    });
  } catch (error) {
    log.database.error('Failed to clear pending changes', {
      error: error.message,
      zone_name: req.params.machineName,
    });
    return res.status(500).json({ error: 'Failed to clear pending changes' });
  }
};

/**
 * @swagger
 * /machines/{machineName}/pending-changes/apply:
 *   post:
 *     summary: Apply the accrued pending changes now
 *     description: Queues the apply against a powered-off machine — they apply automatically at the next agent-driven power cycle otherwise.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Apply task queued
 *       400:
 *         description: Nothing pending, or the machine is not powered off
 */
export const applyZonePendingChanges = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;
    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Machine not found' });
    }
    if (Object.keys(parsePendingSet(zone)).length === 0) {
      return res.status(400).json({ error: 'No pending changes to apply' });
    }
    const currentStatus = await getSystemZoneStatus(zoneName);
    if (!STOPPED_STATUSES.includes(currentStatus)) {
      return res.status(400).json({
        error:
          'Machine must be powered off to apply pending changes now — they apply automatically at the next agent-driven power cycle',
      });
    }
    const task = await queuePendingApply(zone, req.entity.name);
    if (!task) {
      return res.status(500).json({ error: 'Failed to queue pending-changes apply' });
    }
    return res.json({
      success: true,
      task_id: task.id,
      machine_name: zoneName,
      operation: 'zone_modify',
      status: 'pending',
      message: 'Pending changes apply queued',
    });
  } catch (error) {
    log.database.error('Failed to apply pending changes', {
      error: error.message,
      zone_name: req.params.machineName,
    });
    return res.status(500).json({ error: 'Failed to apply pending changes' });
  }
};
