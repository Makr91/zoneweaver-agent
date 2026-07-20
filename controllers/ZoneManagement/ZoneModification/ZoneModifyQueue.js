import Tasks, { TaskPriority } from '../../../models/TaskModel.js';
import { parseConfiguration, mergePendingChanges } from '../../../lib/ZoneConfigUtils.js';
import { getSystemZoneStatus } from '../ZoneQueryController.js';
import { CREDENTIAL_FIELDS, ZONE_ATTR_FIELDS, STOPPED_STATUSES } from './ZoneModifyConstants.js';

export const parsePendingSet = zone => parseConfiguration(zone).pending_changes || {};

export const queueModifyTask = (zoneName, metadata, createdBy) =>
  Tasks.create({
    zone_name: zoneName,
    operation: 'zone_modify',
    priority: TaskPriority.MEDIUM,
    created_by: createdBy,
    metadata: JSON.stringify(metadata),
    status: 'pending',
  });

const extractInfrastructureBody = (body, changeFields) => {
  const infrastructure = {};
  const excluded = [
    'provisioner',
    'notes',
    'tags',
    'snapshots',
    'guest_agent',
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
 * Build the `status: completed` answer for a PUT that changed ONLY
 * immediately-applied fields (nothing queued, nothing accrued). Folds in
 * whatever the guest-agent toggle, resize, and attr writes actually did.
 * @param {string} zoneName - Zone name
 * @param {boolean} guestAgentApplied - Whether the guest-agent toggle changed state
 * @param {Object|null} resized - resize_disks result, or null
 * @param {string[]} appliedAttrs - Direct-attr fields written
 * @returns {Object} The response body
 */
export const buildImmediateResponse = (zoneName, guestAgentApplied, resized, appliedAttrs) => {
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
 * The infrastructure tail of the PUT: accrue against a non-powered-off zone
 * (pending_power_cycle) or queue the zone_modify task, folding the
 * immediately-applied results and transport flags into whichever answer.
 * @param {import('express').Request} req - Request
 * @param {import('express').Response} res - Response
 * @param {string} zoneName - Zone name
 * @param {Object} ctx - {changeFields, warnings, transportFlags, guestAgentApplied, resized, appliedAttrs}
 * @returns {Promise<Object>} The answered response
 */
export const queueInfrastructureChanges = async (req, res, zoneName, ctx) => {
  const { changeFields, warnings, transportFlags, guestAgentApplied, resized, appliedAttrs } = ctx;
  const infrastructureBody = extractInfrastructureBody(req.body, changeFields);
  const pendingResponse = await maybeAccrueChanges(zoneName, infrastructureBody, warnings);
  if (pendingResponse) {
    if (transportFlags.length > 0) {
      pendingResponse.transport_flags_applied = transportFlags;
    }
    return res.json(
      decorateWithImmediate(pendingResponse, guestAgentApplied, resized, appliedAttrs)
    );
  }

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
  if (warnings.length > 0) {
    modifyResponse.resource_warnings = warnings;
  }
  if (transportFlags.length > 0) {
    modifyResponse.transport_flags_applied = transportFlags;
  }
  return res.json(decorateWithImmediate(modifyResponse, guestAgentApplied, resized, appliedAttrs));
};
