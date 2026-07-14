/**
 * @fileoverview Ad-hoc provisioner execution endpoint
 */

import Zones from '../../models/ZoneModel.js';
import { log } from '../../lib/Logger.js';
import { extractPlaybooks } from '../../lib/ProvisionerConfigBuilder.js';
import { validateProvisioningRequest } from './utils/ValidationHelper.js';
import {
  createTask,
  createSequentialPlaybookTasks,
  filterPlaybooksByRun,
  hasZoneProvisionedBefore,
} from './utils/TaskCreationHelper.js';

/**
 * @swagger
 * /machines/{name}/run-provisioners:
 *   post:
 *     summary: Run machine provisioners ad-hoc
 *     description: |
 *       Creates a zone_provision task chain to execute the configured Ansible
 *       playbooks against the machine. This is independent of the full
 *       provisioning pipeline and can be called anytime after SSH is
 *       accessible. Shell scripts (provisioning.shell) run ONLY in the full
 *       pipeline — Hosts.rb has no ad-hoc shell slice (shared rule with the
 *       Go agent).
 *
 *       Prerequisites:
 *       - Machine must be running
 *       - Machine must have provisioning config with provisioners
 *       - SSH must be accessible
 *
 *       Playbooks honor their `run` directive against the machine's provision
 *       history (`always` = every run; `once`/unset = only when never
 *       provisioned; `not_first` = only after a prior successful provision).
 *       When every configured playbook is filtered out, the call succeeds
 *       without creating tasks and reports the skipped playbooks.
 *     tags: [Provisioning Tasks]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Provisioning task created
 *       400:
 *         description: Invalid request or missing provisioning config
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to create provisioning task
 */
export const runProvisioners = async (req, res) => {
  try {
    const zoneName = req.params.name;

    // Validate request
    const zone = await Zones.findOne({ where: { name: zoneName } });
    const validation = await validateProvisioningRequest(zoneName, zone, true);
    if (!validation.valid) {
      return res
        .status(validation.error.includes('not found') ? 404 : 400)
        .json({ error: validation.error });
    }

    const { provisioning, zoneIP, credentials } = validation;

    // Check if there are playbooks configured
    const configuredPlaybooks = extractPlaybooks(provisioning);

    if (configuredPlaybooks.length === 0) {
      return res.status(400).json({
        error: 'No playbooks configured in provisioner metadata',
      });
    }

    const { included: playbooks, skipped } = filterPlaybooksByRun(
      configuredPlaybooks,
      hasZoneProvisionedBefore(zone)
    );

    if (playbooks.length === 0) {
      log.api.info('All playbooks skipped by run directives', {
        zone_name: zoneName,
        skipped,
      });
      return res.json({
        success: true,
        message: `All ${configuredPlaybooks.length} playbooks skipped by their run directives`,
        machine_name: zoneName,
        playbook_count: 0,
        playbooks_skipped: skipped,
      });
    }

    // The parent is a pure anchor (born running, never dispatched); its
    // children start immediately and drive its completion.
    const provisionParentTask = await createTask({
      zone_name: zoneName,
      operation: 'zone_provision_parent',
      metadata: { total_playbooks: playbooks.length, skipped_playbooks: skipped },
      parent: true,
      parent_task_id: null,
      created_by: req.entity.name,
    });

    // Create individual provision tasks sequentially (each depends on previous)
    await createSequentialPlaybookTasks(
      playbooks,
      zoneName,
      zoneIP,
      credentials,
      provisioning,
      provisionParentTask.id,
      null,
      req.entity.name
    );

    log.api.info('Zone provision task chain created', {
      zone_name: zoneName,
      parent_task_id: provisionParentTask.id,
      playbook_count: playbooks.length,
    });

    return res.json({
      success: true,
      message: `Zone provisioners task chain created for ${zoneName}`,
      machine_name: zoneName,
      parent_task_id: provisionParentTask.id,
      playbook_count: playbooks.length,
      playbooks_skipped: skipped,
    });
  } catch (error) {
    log.api.error('Failed to create zone provisioners task', { error: error.message });
    return res.status(500).json({
      error: 'Failed to create zone provisioners task',
      details: error.message,
    });
  }
};
