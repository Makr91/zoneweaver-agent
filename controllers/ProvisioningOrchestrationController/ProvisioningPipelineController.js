/**
 * @fileoverview Provisioning pipeline orchestration endpoints
 */

import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import { validateProvisioningRequest } from './utils/ValidationHelper.js';
import { buildProvisioningTaskChain } from './utils/TaskChainBuilder.js';

/**
 * @swagger
 * /machines/{name}/provision:
 *   post:
 *     summary: Kick off provisioning pipeline for a machine
 *     description: |
 *       Orchestrates the full provisioning pipeline:
 *       1. Boot machine (if not running)
 *       2. Run zlogin recipe (zone_setup) to configure network
 *       3. Wait for SSH to become available (zone_wait_ssh)
 *       4. Sync provisioning files to the machine (zone_sync)
 *       5. Run shell scripts inside the machine (zone_shell) —
 *          provisioning.shell.scripts in list order when
 *          provisioning.shell.enabled; scripts carry no run directive and
 *          run every provision
 *       6. Execute provisioners (zone_provision) — playbooks honor their
 *          `run` directive against the machine's provision history
 *          (`always` = every run; `once`/unset = only when never provisioned;
 *          `not_first` = only after a prior successful provision)
 *
 *       Prerequisites:
 *       - Machine must have provisioning config set via PUT /machines/:name
 *       - Provisioning artifact must be uploaded
 *       - Recipe must exist (if specified)
 *     tags: [Provisioning Pipeline]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               skip_boot:
 *                 type: boolean
 *                 default: false
 *               skip_recipe:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       200:
 *         description: Provisioning pipeline started
 *       400:
 *         description: Invalid request or missing provisioning config
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to start provisioning
 */
export const provisionZone = async (req, res) => {
  try {
    const zoneName = req.params.name;
    const { skip_boot = false, skip_recipe = false } = req.body || {};

    // Validate request
    const zone = await Zones.findOne({ where: { name: zoneName } });
    const validation = await validateProvisioningRequest(zoneName, zone, skip_recipe);
    if (!validation.valid) {
      return res
        .status(validation.error.includes('not found') ? 404 : 400)
        .json({ error: validation.error });
    }

    const { provisioning, recipeId, zoneIP, credentials } = validation;

    // Create Parent Task
    const parentTask = await Tasks.create({
      zone_name: zoneName,
      operation: 'zone_provision_orchestration',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'running', // Start immediately as a container
      metadata: JSON.stringify({ provisioning, recipeId, zoneIP, credentials }),
    });

    // Build task chain
    const taskChain = await buildProvisioningTaskChain({
      zoneName,
      zone,
      skipBoot: skip_boot,
      skipRecipe: skip_recipe,
      recipeId,
      provisioning,
      zoneIP,
      credentials,
      artifactId: provisioning.artifact_id,
      parentTaskId: parentTask.id,
      createdBy: req.entity.name,
    });

    log.api.info('Provisioning pipeline started', {
      zone_name: zoneName,
      steps: taskChain.length,
      first_task: taskChain[0]?.task_id,
      last_task: taskChain[taskChain.length - 1]?.task_id,
    });

    return res.json({
      success: true,
      message: `Provisioning pipeline started for ${zoneName}`,
      machine_name: zoneName,
      parent_task_id: parentTask.id,
      steps: taskChain.length,
      task_chain: taskChain,
    });
  } catch (error) {
    log.api.error('Failed to start provisioning pipeline', { error: error.message });
    return res.status(500).json({
      error: 'Failed to start provisioning pipeline',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /machines/{name}/provision/status:
 *   get:
 *     summary: Get provisioning pipeline status
 *     description: Returns the status of all provisioning-related tasks for a machine.
 *     tags: [Provisioning Pipeline]
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
 *         description: Provisioning status
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to get status
 */
export const getProvisioningStatus = async (req, res) => {
  try {
    const zoneName = req.params.name;

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: `Zone '${zoneName}' not found` });
    }

    // Find all provisioning-related tasks for this zone
    const tasks = await Tasks.findAll({
      where: {
        zone_name: zoneName,
        operation: [
          'zone_provision_orchestration',
          'zone_provisioning_extract',
          'zone_provisioning_stage',
          'zone_setup',
          'zone_wait_ssh',
          'zone_sync_parent',
          'zone_sync',
          'zone_shell_parent',
          'zone_shell',
          'zone_provision_parent',
          'zone_provision',
          'zone_syncback_parent',
          'zone_syncback',
        ],
      },
      order: [['created_at', 'DESC']],
      limit: 20,
    });

    let zoneConfig = zone.configuration || {};
    if (typeof zoneConfig === 'string') {
      try {
        zoneConfig = JSON.parse(zoneConfig);
      } catch (e) {
        log.api.warn('Failed to parse zone configuration', { error: e.message });
        zoneConfig = {};
      }
    }
    const provisionerState = zoneConfig.provisioner_state || {};

    return res.json({
      success: true,
      machine_name: zoneName,
      provisioning_configured: Boolean(zoneConfig.provisioner),
      provisioning_status: provisionerState.last_provisioned_at ? 'provisioned' : 'not_started',
      last_provisioned_at: provisionerState.last_provisioned_at || null,
      recent_tasks: tasks,
    });
  } catch (error) {
    log.api.error('Failed to get provisioning status', { error: error.message });
    return res.status(500).json({
      error: 'Failed to get provisioning status',
      details: error.message,
    });
  }
};
