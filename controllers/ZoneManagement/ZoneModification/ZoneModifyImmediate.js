import { consoleportRangeError } from '../../../lib/ZoneValidation.js';
import {
  readZonecfgAttr,
  getZoneConfig,
  parseConfiguration,
} from '../../../lib/ZoneConfigUtils.js';
import {
  setSnapshotPolicy,
  mergeSettingsKeys,
  setDocumentNetworkKey,
} from '../../../lib/ZoneConfigMutators.js';
import { executeCommand } from '../../../lib/CommandManager.js';
import { resizeMachineDisks } from '../../../lib/MachineDiskResize.js';
import { validateTypedDiskEntries, validateTypedImageEntries } from '../../../lib/DiskSpec.js';
import { isGuestAgentEnabled } from '../../../lib/QemuGuestAgent.js';
import { applyGuestAgentToggle } from '../../GuestAgentController.js';
import { getSystemZoneStatus } from '../ZoneQueryController.js';
import { CREDENTIAL_FIELDS, ZONE_ATTR_FIELDS, STOPPED_STATUSES } from './ZoneModifyConstants.js';

/**
 * Validate the direct-attr fields; answers the 400 (and returns false) on the
 * first invalid value, so callers just bail. consoleport carries the agreed
 * cross-agent refusal string (consensus 2026-07-17); null/'' clears the attr.
 */
export const validateZoneAttrFields = (body, res) => {
  const bootPriority = body.boot_priority;
  if (bootPriority !== undefined && bootPriority !== null && bootPriority !== '') {
    const num = Number(bootPriority);
    if (!Number.isInteger(num) || num < 1 || num > 100) {
      res
        .status(400)
        .json({ error: 'boot_priority must be an integer 1-100 (null clears; default 95)' });
      return false;
    }
  }
  const consoleportProblem = consoleportRangeError(body.consoleport);
  if (consoleportProblem) {
    res.status(400).json({ error: consoleportProblem });
    return false;
  }
  return true;
};

/**
 * Apply the direct-attr fields present in the body via ONE batched zonecfg
 * transaction (select-or-add per attr, remove on null/''), through the
 * offline store. Returns the applied field names.
 * @throws {Error} When the zonecfg apply fails
 */
export const applyZoneAttrFields = async (zoneName, body) => {
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
export const handleResizeDisks = async (res, zoneName, entries) => {
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
    return { response: res.status(400).json({ error: error.message }) };
  }
};

/**
 * Validate the add_disks wire at the PUT (frozen TYPED entries, converged
 * 2026-07-18) — shape + image host-truth refused up front on both the queue
 * and accrue paths; the executor re-enforces. Returns the entries' warnings;
 * a refusal answers the request and returns null.
 * @param {import('express').Request} req - Request
 * @param {import('express').Response} res - Response
 * @returns {Promise<Array|null>} Warnings, or null when the request was answered
 */
export const validateAddDisksWire = async (req, res) => {
  if (req.body.add_disks === undefined) {
    return [];
  }
  if (!Array.isArray(req.body.add_disks) || req.body.add_disks.length === 0) {
    res.status(400).json({ error: 'add_disks must be a non-empty array' });
    return null;
  }
  const typed = validateTypedDiskEntries(req.body.add_disks, 'add_disks');
  if (typed.errors.length > 0) {
    res.status(400).json({ error: typed.errors[0] });
    return null;
  }
  const imageErrors = await validateTypedImageEntries(req.body.add_disks, 'add_disks');
  if (imageErrors.length > 0) {
    res.status(400).json({ error: imageErrors[0] });
    return null;
  }
  return typed.warnings;
};

export const applyImmediateFields = async (zone, zoneName, body) => {
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
export const applyProvisionerImmediate = async (zone, zoneName, body, changeFields) => {
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
 * Handle the guest_agent toggle field (shared contract with the Go agent):
 * applied SYNCHRONOUSLY through zonecfg's offline store regardless of power
 * state — never accrues, never queues; the caller's answer carries
 * requires_restart. Gate/validation problems answer the request here.
 * @param {import('express').Request} req - Request
 * @param {import('express').Response} res - Response
 * @param {string} zoneName - Zone name
 * @returns {Promise<{applied: boolean, response?: object}>}
 */
export const handleGuestAgentField = async (req, res, zoneName) => {
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
 * Apply remove_on_completion flips riding update_nics entries (the converged
 * post-create toggle wire, 2026-07-18): a DOCUMENT-side edit, applied
 * immediately — the agent maps the NIC's physical to the paired networks[]
 * entry (live net index ↔ document index, the declared pairing rule) and
 * records the flag. The key is STRIPPED from the entries afterwards so the
 * zonecfg path never sees it; entries reduced to bare selectors drop.
 * @param {string} zoneName - Zone name
 * @param {Object} body - Request body (update_nics mutated)
 * @returns {Promise<string[]>} The physicals whose flag was recorded
 * @throws {Error} Unknown physical / no paired document entry
 */
export const applyTransportFlagFlips = async (zoneName, body) => {
  if (!Array.isArray(body.update_nics)) {
    return [];
  }
  const flips = body.update_nics.filter(entry => entry && entry.remove_on_completion !== undefined);
  if (flips.length === 0) {
    return [];
  }
  const liveConfig = await getZoneConfig(zoneName);
  const nets = Array.isArray(liveConfig?.net) ? liveConfig.net : [];
  const applied = await Promise.all(
    flips.map(async entry => {
      const index = nets.findIndex(net => net?.physical === entry.physical);
      if (index === -1) {
        throw new Error(`update_nics: no net resource with physical ${entry.physical}`);
      }
      const recorded = await setDocumentNetworkKey(
        zoneName,
        index,
        'remove_on_completion',
        entry.remove_on_completion === true
      );
      if (!recorded) {
        throw new Error(
          `update_nics: ${entry.physical} has no paired document networks[${index}] entry`
        );
      }
      delete entry.remove_on_completion;
      return entry.physical;
    })
  );
  body.update_nics = body.update_nics.filter(
    entry => entry && Object.keys(entry).some(key => key !== 'physical')
  );
  if (body.update_nics.length === 0) {
    delete body.update_nics;
  }
  return applied;
};

/**
 * Apply update_nics remove_on_completion flips and answer the flag-only PUT
 * (status completed + transport_flags_applied). Returns the applied list; a
 * refusal or flag-only completion answers the request and returns null.
 * @param {import('express').Request} req - Request
 * @param {import('express').Response} res - Response
 * @param {string} zoneName - Zone name
 * @param {string[]} changeFields - The recognized change fields
 * @returns {Promise<string[]|null>} Applied physicals, or null when answered
 */
export const handleTransportFlags = async (req, res, zoneName, changeFields) => {
  let transportFlags = [];
  try {
    transportFlags = await applyTransportFlagFlips(zoneName, req.body);
  } catch (flipError) {
    res.status(400).json({ error: flipError.message });
    return null;
  }
  if (transportFlags.length > 0 && !changeFields.some(field => req.body[field] !== undefined)) {
    res.json({
      success: true,
      machine_name: zoneName,
      operation: 'zone_modify',
      status: 'completed',
      message: 'Transport removal flag updated.',
      requires_restart: false,
      transport_flags_applied: transportFlags,
    });
    return null;
  }
  return transportFlags;
};
