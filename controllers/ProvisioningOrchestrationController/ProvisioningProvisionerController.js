/**
 * @fileoverview Ad-hoc provisioner execution endpoint
 */

import Zones from '../../models/ZoneModel.js';
import { log } from '../../lib/Logger.js';
import { validateProvisioningRequest } from './utils/ValidationHelper.js';
import { createTask } from './utils/TaskCreationHelper.js';
import { buildProvisioningWalk, applyWalkSettings } from './utils/TaskChainBuilder.js';

/**
 * @swagger
 * /machines/{name}/run-provisioners:
 *   post:
 *     summary: Run machine provisioners ad-hoc
 *     description: |
 *       THE SAME SINGLE DOCUMENT WALK as the full pipeline (the no-phases
 *       ruling): pre[] hooks, then the document's provisioning methods in
 *       the order their KEYS APPEAR (shell/ansible/docker, entries in list
 *       order, run directives per entry), then post[] hooks — one chain
 *       under one anchor. No infra steps and no folders bracket (those are
 *       the pipeline's; /sync covers folders ad-hoc). Callable anytime after
 *       the guest transport answers.
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
 *         description: The walk's task chain (empty walk succeeds with zero tasks)
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

    // Validate request. Zone existence answers 404 explicitly — never the
    // error-string sniff (the no-transport refusal contains "not found").
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: `Zone '${zoneName}' not found` });
    }
    const validation = await validateProvisioningRequest(zoneName, zone, true);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const { provisioning, zoneConfig, zoneIP, credentials } = validation;

    // The anchor is a pure anchor (born running, never dispatched); the
    // walk's children start immediately and drive its completion.
    const parentTask = await createTask({
      zone_name: zoneName,
      operation: 'zone_provision_parent',
      metadata: { ad_hoc: true },
      parent: true,
      parent_task_id: null,
      created_by: req.entity.name,
    });

    const ctx = {
      zone,
      zoneName,
      zoneIP,
      credentials,
      provisioning,
      parentTaskId: parentTask.id,
      createdBy: req.entity.name,
      taskChain: [],
    };
    applyWalkSettings(ctx, zoneConfig);
    await buildProvisioningWalk(ctx, null);

    // A childless anchor would sit running forever (the child rollup drives
    // its state) — an empty walk completes it on the spot. Count only REAL
    // tasks: the chain also carries narration entries (winrm skips, shadowed
    // communicator keys) that create no child.
    const taskCount = ctx.taskChain.filter(entry => entry.task_id).length;
    if (taskCount === 0) {
      await parentTask.update({
        status: 'completed',
        completed_at: new Date(),
        progress_percent: 100,
      });
    }

    log.api.info('Ad-hoc provisioner walk created', {
      zone_name: zoneName,
      parent_task_id: parentTask.id,
      steps: taskCount,
    });

    return res.json({
      success: true,
      message:
        taskCount > 0
          ? `Provisioner walk created for ${zoneName} (${taskCount} step(s), document order)`
          : `Nothing to run — the document's walk produced no steps (gates/run directives)`,
      machine_name: zoneName,
      parent_task_id: parentTask.id,
      task_chain: ctx.taskChain,
    });
  } catch (error) {
    log.api.error('Failed to create zone provisioners task', { error: error.message });
    return res.status(500).json({
      error: 'Failed to create zone provisioners task',
      details: error.message,
    });
  }
};
