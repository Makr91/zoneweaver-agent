/**
 * @fileoverview Provisioning pipeline orchestration endpoints
 */

import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';
import { parseConfiguration } from '../../lib/ZoneConfigUtils.js';
import { extractHooks } from '../../lib/ProvisionerConfigBuilder.js';
import { validateProvisioningRequest } from './utils/ValidationHelper.js';
import { buildProvisioningTaskChain } from './utils/TaskChainBuilder.js';

/**
 * Host-hook PRE-FLIGHT gate (provisioning-design §5): host-target hooks are
 * config-gated (`provisioning.host_hooks`, zoneweaver default OFF — shared
 * hosts), and a document carrying them needs a ONE-TIME confirmation. The
 * check is strictly pre-flight — the provision request is refused up front
 * with a needs-confirmation answer; a running sequence is never aborted by
 * it. `confirm_host_hooks: true` in the body records the confirmation on the
 * zone (provisioner_state.host_hooks_confirmed) so later runs never re-prompt.
 * @param {Object} zone - Zone database record
 * @param {Object} provisioning - Provisioner document
 * @param {Object} body - Request body
 * @returns {Promise<{status: number, payload: Object}|null>} Refusal or null
 */
const hostHookPreflight = async (zone, provisioning, body) => {
  const hostHooks = ['pre', 'post']
    .flatMap(phase => extractHooks(provisioning, phase).map(hook => ({ ...hook, phase })))
    .filter(hook => hook.target === 'host');
  if (hostHooks.length === 0) {
    return null;
  }

  const provConfig = config.get('provisioning') || {};
  if (provConfig.host_hooks !== true) {
    return {
      status: 400,
      payload: {
        error:
          'This document carries host-target hooks, and host hooks are disabled on this agent (provisioning.host_hooks — zoneweaver default OFF)',
        host_hooks: hostHooks.map(({ script, phase }) => ({ script, phase })),
      },
    };
  }

  const zoneConfig = parseConfiguration(zone);
  // The shared wire (Go parity): the confirmation records at the
  // configuration TOP LEVEL, and the 409 carries {needs_confirmation,
  // reason, confirm_with}.
  if (zoneConfig.host_hooks_confirmed === true) {
    return null;
  }
  if (body?.confirm_host_hooks !== true) {
    return {
      status: 409,
      payload: {
        needs_confirmation: true,
        reason: `This document runs ${hostHooks.length} script(s) ON THE AGENT HOST (${hostHooks
          .map(({ script, phase }) => `${phase}: ${script}`)
          .join(', ')}) — one-time confirmation required`,
        confirm_with: { confirm_host_hooks: true },
      },
    };
  }

  // Record the one-time confirmation (fresh clone — the Sequelize JSON
  // change-detection rule).
  const freshConfig = structuredClone(zoneConfig);
  freshConfig.host_hooks_confirmed = true;
  await Zones.update({ configuration: freshConfig }, { where: { name: zone.name } });
  return null;
};

/**
 * @swagger
 * /machines/{name}/provision:
 *   post:
 *     summary: Kick off provisioning pipeline for a machine
 *     description: |
 *       THE DOCUMENT IS THE PROGRAM (the no-phases ruling): after the infra
 *       steps (boot if needed → zlogin recipe → zone_wait_ssh, or win_ping
 *       over winrm when settings.vagrant_communicator is winrm), the run is
 *       the stored document executed AS WRITTEN — folders[] sync opens the
 *       bracket, then pre[] hooks, then the provisioning section's METHOD
 *       KEYS IN THE ORDER THEY APPEAR (shell → zone_shell per script;
 *       ansible → groups in list order, each group's local[] then remote[]
 *       per its own lists, zone_provision / zone_provision_remote per entry,
 *       run directives filtered per entry, provisioned-state stamp on the
 *       run's overall last playbook; docker → zone_docker_compose per
 *       nested compose file), then post[] hooks, then syncback closes the
 *       bracket. Nothing is grouped by type or reordered by the agent;
 *       unknown method keys survive in the document and are narrated as
 *       unexecutable.
 *
 *       Host-target hooks are PRE-FLIGHT gated: provisioning.host_hooks
 *       (agent config, default OFF) must be on, and the FIRST run needs
 *       confirm_host_hooks: true (recorded at configuration.host_hooks_confirmed;
 *       never re-prompts).
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
 *               confirm_host_hooks:
 *                 type: boolean
 *                 default: false
 *                 description: One-time confirmation for documents carrying host-target hooks
 *     responses:
 *       200:
 *         description: Provisioning pipeline started
 *       400:
 *         description: Invalid request, missing provisioning config, or host hooks disabled
 *       404:
 *         description: Zone not found
 *       409:
 *         description: Host-target hooks need confirmation — body carries needs_confirmation + host_hooks[]
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

    // Host-hook pre-flight (§5): refused up front, never mid-sequence.
    const hookRefusal = await hostHookPreflight(zone, provisioning, req.body);
    if (hookRefusal) {
      return res.status(hookRefusal.status).json(hookRefusal.payload);
    }

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
          'zone_hook',
          'zone_sync_parent',
          'zone_sync',
          'zone_shell',
          'zone_docker_compose',
          'zone_provision_parent',
          'zone_provision',
          'zone_provision_remote',
          'zone_syncback_parent',
          'zone_syncback',
        ],
      },
      order: [['created_at', 'DESC']],
      limit: 20,
    });

    const zoneConfig = parseConfiguration(zone);
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
