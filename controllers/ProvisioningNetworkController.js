/**
 * @fileoverview Provisioning Network Controller for Zoneweaver Agent
 * @description Orchestrates the setup and teardown of the provisioning network backbone
 *              by creating a sequence of tasks for Etherstub, VNIC, Network, NAT, and DHCP managers.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { log } from '../lib/Logger.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import NatRules from '../models/NatRuleModel.js';
import { stringifyAsync } from '../lib/AsyncJson.js';
import {
  executeCommand,
  getProvNetConfig,
  componentExists,
  checkProvisioningNetworkReady,
} from './ProvisioningNetwork/ProvisioningNetworkUtils.js';
import { queueProvisioningNetworkSetup } from './ProvisioningNetwork/ProvisioningNetworkSetupQueue.js';

/**
 * @swagger
 * /provisioning/bridged-interfaces:
 *   get:
 *     summary: List all valid VNIC parents
 *     description: |
 *       Every datalink a VNIC can be created over, as FLAT rows `{name,
 *       class, state}` (the converged uplink-picker wire, shared with the Go
 *       agent). Classes here: phys/aggr/etherstub/simnet/overlay. Aggregate
 *       MEMBER links are excluded — their traffic rides the aggr. The
 *       provisioning etherstub is included and badged `provisioning: true`
 *       (it is how provisioning networks attach — never hidden). Link state
 *       is carried, never filtered; pickers filter client-side (external =
 *       phys/aggr, internal = etherstub).
 *     tags: [Provisioning Network]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: VNIC parent rows
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 interfaces:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       class:
 *                         type: string
 *                         enum: [phys, aggr, etherstub, simnet, overlay]
 *                       state: { type: string }
 *                       status:
 *                         type: string
 *                         enum: [up, down]
 *                         description: Normalized link status (absent = unknown) — the converged picker field; pickers hide down rows
 *                       wireless:
 *                         type: boolean
 *                         description: Whether the link is a wireless medium (absent = unknown)
 *                       provisioning: { type: boolean }
 *                 excluded_aggr_members:
 *                   type: array
 *                   items: { type: string }
 *                 total:
 *                   type: integer
 *       500:
 *         description: Failed to enumerate links
 */
export const getBridgedInterfaces = async (req, res) => {
  void req;
  try {
    const netConfig = getProvNetConfig();
    const vnicParentClasses = ['phys', 'aggr', 'etherstub', 'simnet', 'overlay'];

    const linksResult = await executeCommand('pfexec dladm show-link -p -o link,class,state');
    if (!linksResult.success) {
      return res.status(500).json({
        error: 'Failed to enumerate links',
        details: linksResult.error,
      });
    }

    const mediaByLink = new Map();
    const physResult = await executeCommand('pfexec dladm show-phys -p -o link,media');
    if (physResult.success && physResult.output) {
      for (const line of physResult.output.split('\n')) {
        const [link, media] = line.split(':');
        if (link && media) {
          mediaByLink.set(link, media);
        }
      }
    }

    const memberLinks = new Set();
    const aggrResult = await executeCommand('pfexec dladm show-aggr -x -p -o link,port');
    if (aggrResult.success && aggrResult.output) {
      for (const line of aggrResult.output.split('\n')) {
        const [, port] = line.split(':');
        if (port) {
          memberLinks.add(port);
        }
      }
    }

    const interfaces = [];
    for (const line of linksResult.output.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const [link, linkClass, state] = line.split(':');
      if (!vnicParentClasses.includes(linkClass) || memberLinks.has(link)) {
        continue;
      }
      const entry = { name: link, class: linkClass, state };
      if (state === 'up' || state === 'down') {
        entry.status = state;
      }
      const media = mediaByLink.get(link);
      if (media) {
        entry.wireless = media === 'WiFi';
      }
      if (link === netConfig.etherstub_name) {
        entry.provisioning = true;
      }
      interfaces.push(entry);
    }

    return res.json({
      interfaces,
      excluded_aggr_members: [...memberLinks],
      total: interfaces.length,
    });
  } catch (error) {
    log.api.error('Failed to list bridged interfaces', { error: error.message });
    return res.status(500).json({
      error: 'Failed to enumerate links',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /provisioning/network/status:
 *   get:
 *     summary: Get provisioning network status
 *     description: |
 *       Checks whether the provisioning network components are configured:
 *       etherstub, host VNIC, IP address, NAT rule, IP forwarding, and DHCP.
 *     tags: [Provisioning Network]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: >-
 *           Provisioning network status. When the provisioning network is disabled in
 *           configuration the response is just { enabled: false, message } — the
 *           ready/components/config fields are only present when enabled.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                   description: Present only on the disabled branch
 *                 ready:
 *                   type: boolean
 *                 components:
 *                   type: object
 *                   properties:
 *                     etherstub: { type: object }
 *                     vnic: { type: object }
 *                     ip_address: { type: object }
 *                     nat: { type: object }
 *                     ip_forwarding: { type: object }
 *                     dhcp: { type: object }
 *                 config:
 *                   type: object
 *       500:
 *         description: Failed to check provisioning network status
 */
export const getProvisioningNetworkStatus = async (req, res) => {
  void req;
  try {
    const netConfig = getProvNetConfig();

    if (!netConfig.enabled) {
      return res.json({
        enabled: false,
        message: 'Provisioning network is disabled in configuration',
      });
    }

    const readiness = await checkProvisioningNetworkReady(netConfig);

    return res.json({
      enabled: true,
      ready: readiness.ready,
      components: {
        etherstub: { name: netConfig.etherstub_name, exists: readiness.etherstubExists },
        vnic: { name: netConfig.host_vnic_name, exists: readiness.vnicExists },
        ip_address: { address: `${netConfig.host_ip}/24`, configured: readiness.ipExists },
        nat: { configured: readiness.natConfigured },
        ip_forwarding: { enabled: readiness.forwardingEnabled },
        dhcp: { running: readiness.dhcpRunning },
      },
      config: netConfig,
    });
  } catch (error) {
    log.api.error('Failed to check provisioning network status', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Failed to check provisioning network status', details: error.message });
  }
};

/**
 * The packaged-provisioning ensure hook (Mark's ruling: a VM spun via a
 * provisioner makes sure the provisioning network was set up in the first
 * place). Enabled + fully ready = null, zero tasks; anything missing queues
 * the idempotent setup chain and the caller gates its first task on
 * lastTaskId.
 * @param {string} createdBy - Task creator
 * @returns {Promise<{parentTaskId: string, taskIds: string[], lastTaskId: string}|null>}
 */
export const ensureProvisioningNetwork = async createdBy => {
  const netConfig = getProvNetConfig();
  if (!netConfig.enabled) {
    return null;
  }
  const readiness = await checkProvisioningNetworkReady(netConfig);
  if (readiness.ready) {
    return null;
  }
  log.api.info('Provisioning network not ready — queueing setup chain', {
    etherstub: readiness.etherstubExists,
    vnic: readiness.vnicExists,
    ip: readiness.ipExists,
    nat: readiness.natConfigured,
    forwarding: readiness.forwardingEnabled,
    dhcp: readiness.dhcpRunning,
  });
  return queueProvisioningNetworkSetup(createdBy);
};

/**
 * @swagger
 * /provisioning/network/setup:
 *   post:
 *     summary: Setup provisioning network (Async)
 *     description: |
 *       Queues a sequence of tasks to setup the provisioning network backbone.
 *       Tasks include: creating etherstub, VNIC, IP address, NAT rule, enabling forwarding, and configuring DHCP.
 *     tags: [Provisioning Network]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       202:
 *         description: Provisioning network setup tasks queued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 parent_task_id:
 *                   type: string
 *                   format: uuid
 *                 task_ids:
 *                   type: array
 *                   items:
 *                     type: string
 *                     format: uuid
 *                 config:
 *                   type: object
 *                   description: The provisioning network configuration used
 *       500:
 *         description: Provisioning network setup failed
 */
export const setupProvisioningNetwork = async (req, res) => {
  try {
    const result = await queueProvisioningNetworkSetup(req.entity.name);
    return res.status(202).json({
      success: true,
      message: `Provisioning network setup tasks queued (${result.taskIds.length} tasks)`,
      parent_task_id: result.parentTaskId,
      task_ids: result.taskIds,
      config: result.config,
    });
  } catch (error) {
    log.api.error('Provisioning network setup failed', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Provisioning network setup failed', details: error.message });
  }
};

/**
 * @swagger
 * /provisioning/network/teardown:
 *   delete:
 *     summary: Teardown provisioning network
 *     description: |
 *       Removes all provisioning network components in reverse setup order:
 *       DHCP, NAT rule, interconnect forwarding (global forwarding and the
 *       external bridge are never touched), IP address, VNIC, etherstub.
 *     tags: [Provisioning Network]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       202:
 *         description: Provisioning network teardown tasks queued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 parent_task_id:
 *                   type: string
 *                   format: uuid
 *                 task_ids:
 *                   type: array
 *                   items:
 *                     type: string
 *                     format: uuid
 *       500:
 *         description: Provisioning network teardown failed
 */
export const teardownProvisioningNetwork = async (req, res) => {
  try {
    const netConfig = getProvNetConfig();
    const createdBy = req.entity.name;
    const taskIds = [];
    let lastTaskId = null;

    const parentTask = await Tasks.create({
      zone_name: 'system',
      operation: 'provisioning_network_teardown',
      priority: TaskPriority.NORMAL,
      created_by: createdBy,
      status: 'running',
      metadata: JSON.stringify(netConfig),
    });

    const queueTask = async (operation, metadata) => {
      const task = await Tasks.create({
        zone_name: 'system',
        operation,
        priority: TaskPriority.HIGH,
        created_by: createdBy,
        status: 'pending',
        parent_task_id: parentTask.id,
        depends_on: lastTaskId,
        metadata: await stringifyAsync(metadata),
      });
      lastTaskId = task.id;
      taskIds.push(task.id);
      return task;
    };

    await queueTask('dhcp_service_control', { action: 'stop' });

    const natRule = await NatRules.findOne({ where: { subnet: netConfig.subnet } });
    if (natRule) {
      await queueTask('delete_nat_rule', { rule_id: natRule.id });
    }

    if (await componentExists('vnic', netConfig.host_vnic_name)) {
      await queueTask('configure_forwarding', {
        enabled: false,
        interfaces: [netConfig.host_vnic_name],
        global: false,
      });
    }

    const addrobj = `${netConfig.host_vnic_name}/v4static`;
    if (await componentExists('ip', addrobj)) {
      await queueTask('delete_ip_address', { addrobj });
    }

    if (await componentExists('vnic', netConfig.host_vnic_name)) {
      await queueTask('delete_vnic', { vnic: netConfig.host_vnic_name });
    }

    if (await componentExists('etherstub', netConfig.etherstub_name)) {
      await queueTask('delete_etherstub', { etherstub: netConfig.etherstub_name });
    }

    return res.status(202).json({
      success: true,
      message: `Provisioning network teardown tasks queued (${taskIds.length} tasks)`,
      parent_task_id: parentTask.id,
      task_ids: taskIds,
    });
  } catch (error) {
    log.api.error('Provisioning network teardown failed', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Provisioning network teardown failed', details: error.message });
  }
};
