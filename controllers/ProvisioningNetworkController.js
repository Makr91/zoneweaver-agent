/**
 * @fileoverview Provisioning Network Controller for Zoneweaver Agent
 * @description Orchestrates the setup and teardown of the provisioning network backbone
 *              by creating a sequence of tasks for Etherstub, VNIC, Network, NAT, and DHCP managers.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import config from '../config/ConfigLoader.js';
import { log } from '../lib/Logger.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import NatRules from '../models/NatRuleModel.js';
import yj from 'yieldable-json';

const execPromise = util.promisify(exec);

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
const executeCommand = async command => {
  try {
    const { stdout } = await execPromise(command, {
      encoding: 'utf8',
      timeout: 30000,
    });
    return { success: true, output: stdout.trim() };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      output: error.stdout || '',
    };
  }
};

/**
 * Get provisioning network configuration from config.yaml
 * @returns {Object} Provisioning network config with defaults
 */
const getProvNetConfig = () => {
  const provConfig = config.get('provisioning') || {};
  const netConfig = provConfig.network || {};
  return {
    enabled: netConfig.enabled !== false,
    // Fallbacks match the settings schema + shipped config defaults exactly.
    etherstub_name: netConfig.etherstub_name || 'estub_provision',
    host_vnic_name: netConfig.host_vnic_name || 'provision_interconnect0',
    subnet: netConfig.subnet || '10.190.190.0/24',
    host_ip: netConfig.host_ip || '10.190.190.1',
    netmask: netConfig.netmask || '255.255.255.0',
    dhcp_range_start: netConfig.dhcp_range_start || '10.190.190.10',
    dhcp_range_end: netConfig.dhcp_range_end || '10.190.190.254',
  };
};

/**
 * Check if a component exists
 */
const componentExists = async (type, name) => {
  let cmd;
  switch (type) {
    case 'etherstub':
      cmd = `pfexec dladm show-etherstub ${name} 2>/dev/null`;
      break;
    case 'vnic':
      cmd = `pfexec dladm show-vnic ${name} 2>/dev/null`;
      break;
    case 'ip':
      cmd = `pfexec ipadm show-addr ${name} 2>/dev/null`;
      break;
    default:
      return false;
  }
  const result = await executeCommand(cmd);
  return result.success && result.output.length > 0;
};

/**
 * Detect the active external interface for NAT bridge
 * @returns {Promise<string|null>}
 */
const detectActiveInterface = async () => {
  // Try to find the default route interface
  const routeResult = await executeCommand('pfexec route -n get default 2>/dev/null');
  if (routeResult.success) {
    const ifMatch = routeResult.output.match(/interface:\s*(?<iface>\S+)/);
    if (ifMatch) {
      return ifMatch.groups.iface;
    }
  }

  // Fallback: find first UP interface that isn't loopback or our provisioning VNIC
  const netConfig = getProvNetConfig();
  const ifResult = await executeCommand('pfexec dladm show-link -p -o link,state');
  if (ifResult.success) {
    const lines = ifResult.output.split('\n');
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length >= 2 && parts[1] === 'up') {
        const [iface] = parts;
        if (iface !== 'lo0' && iface !== netConfig.host_vnic_name && !iface.startsWith('estub')) {
          return iface;
        }
      }
    }
  }

  return null;
};

/**
 * @swagger
 * /provisioning/bridged-interfaces:
 *   get:
 *     summary: List all valid VNIC parents
 *     description: |
 *       Every datalink a VNIC can be created over, grouped by class
 *       (phys/aggr/etherstub/simnet/overlay). Aggregate MEMBER links are
 *       excluded — their traffic rides the aggr. The provisioning etherstub is
 *       included and badged `provisioning: true` (it is how provisioning
 *       networks attach — never hidden). Link state is carried, never
 *       filtered; pickers filter client-side (external = phys/aggr,
 *       internal = etherstub).
 *     tags: [Provisioning Network]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: VNIC parents grouped by class
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 interfaces:
 *                   type: object
 *                   properties:
 *                     phys:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           link: { type: string }
 *                           state: { type: string }
 *                           provisioning: { type: boolean }
 *                     aggr: { type: array, items: { type: object } }
 *                     etherstub: { type: array, items: { type: object } }
 *                     simnet: { type: array, items: { type: object } }
 *                     overlay: { type: array, items: { type: object } }
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

    // Aggregate MEMBER links carry the aggr's traffic — never valid parents.
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

    const interfaces = { phys: [], aggr: [], etherstub: [], simnet: [], overlay: [] };
    let total = 0;
    for (const line of linksResult.output.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const [link, linkClass, state] = line.split(':');
      if (!vnicParentClasses.includes(linkClass) || memberLinks.has(link)) {
        continue;
      }
      const entry = { link, state };
      if (link === netConfig.etherstub_name) {
        entry.provisioning = true;
      }
      interfaces[linkClass].push(entry);
      total++;
    }

    return res.json({
      interfaces,
      excluded_aggr_members: [...memberLinks],
      total,
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

    // Check each component
    const etherstubExists = await componentExists('etherstub', netConfig.etherstub_name);
    const vnicExists = await componentExists('vnic', netConfig.host_vnic_name);
    const ipExists = await componentExists('ip', `${netConfig.host_vnic_name}/v4static`);

    // Check NAT rule
    const natResult = await executeCommand('cat /etc/ipf/ipnat.conf 2>/dev/null');
    const [subnetBase] = netConfig.subnet.split('/');
    const natConfigured = natResult.success && natResult.output.includes(subnetBase);

    // Check IP forwarding
    const fwdResult = await executeCommand('pfexec routeadm -p 2>/dev/null');
    const forwardingEnabled =
      fwdResult.success &&
      fwdResult.output.includes('ipv4-forwarding') &&
      fwdResult.output.includes('current=enabled');

    // Check DHCP
    const dhcpResult = await executeCommand(
      'svcs -H -o state network/service/dhcp:ipv4 2>/dev/null'
    );
    const dhcpRunning = dhcpResult.success && dhcpResult.output.trim() === 'online';

    const allReady =
      etherstubExists &&
      vnicExists &&
      ipExists &&
      natConfigured &&
      forwardingEnabled &&
      dhcpRunning;

    return res.json({
      enabled: true,
      ready: allReady,
      components: {
        etherstub: { name: netConfig.etherstub_name, exists: etherstubExists },
        vnic: { name: netConfig.host_vnic_name, exists: vnicExists },
        ip_address: { address: `${netConfig.host_ip}/24`, configured: ipExists },
        nat: { configured: natConfigured },
        ip_forwarding: { enabled: forwardingEnabled },
        dhcp: { running: dhcpRunning },
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
    const netConfig = getProvNetConfig();
    const createdBy = req.entity.name;
    const taskIds = [];
    let lastTaskId = null;

    // Create Parent Task
    const parentTask = await Tasks.create({
      zone_name: 'system',
      operation: 'provisioning_network_setup',
      priority: TaskPriority.NORMAL,
      created_by: createdBy,
      status: 'running', // Start immediately as a container
      metadata: JSON.stringify(netConfig),
    });

    // Helper to create chained tasks
    const queueTask = async (operation, metadata) => {
      const task = await Tasks.create({
        zone_name: 'system',
        operation,
        priority: TaskPriority.HIGH, // Subtasks run at higher priority to finish quickly
        created_by: createdBy,
        status: 'pending',
        parent_task_id: parentTask.id,
        depends_on: lastTaskId,
        metadata: await new Promise(resolve => {
          yj.stringifyAsync(metadata, (err, result) => {
            void err;
            resolve(result);
          });
        }),
      });
      lastTaskId = task.id;
      taskIds.push(task.id);
      return task;
    };

    // 1. Create Etherstub
    if (!(await componentExists('etherstub', netConfig.etherstub_name))) {
      await queueTask('create_etherstub', { name: netConfig.etherstub_name });
    }

    // 2. Create Host VNIC
    if (!(await componentExists('vnic', netConfig.host_vnic_name))) {
      await queueTask('create_vnic', {
        name: netConfig.host_vnic_name,
        link: netConfig.etherstub_name,
      });
    }

    // 3. Create IP Address
    const addrobj = `${netConfig.host_vnic_name}/v4static`;
    if (!(await componentExists('ip', addrobj))) {
      const prefixLen = netConfig.subnet.split('/')[1] || '24';
      await queueTask('create_ip_address', {
        interface: netConfig.host_vnic_name,
        type: 'static',
        addrobj,
        address: `${netConfig.host_ip}/${prefixLen}`,
      });
    }

    // 4. Configure NAT Rule
    const bridge = await detectActiveInterface();
    if (bridge) {
      await queueTask('create_nat_rule', {
        bridge,
        subnet: netConfig.subnet,
        target: '0/32',
        protocol: 'tcp/udp',
        type: 'portmap',
        created_by: createdBy,
      });

      // 5. Enable IP Forwarding
      await queueTask('configure_forwarding', {
        enabled: true,
        interfaces: [bridge, netConfig.host_vnic_name],
      });
    } else {
      log.api.warn('Could not detect active interface for NAT, skipping NAT/Forwarding tasks');
    }

    // 6. Configure DHCP
    const [subnetBase] = netConfig.subnet.split('/');
    await queueTask('dhcp_update_config', {
      subnet: subnetBase,
      netmask: netConfig.netmask,
      router: netConfig.host_ip,
      range_start: netConfig.dhcp_range_start,
      range_end: netConfig.dhcp_range_end,
      listen_interface: netConfig.host_vnic_name,
    });

    // 7. Start/Refresh DHCP Service
    await queueTask('dhcp_service_control', { action: 'restart' });

    return res.status(202).json({
      success: true,
      message: `Provisioning network setup tasks queued (${taskIds.length} tasks)`,
      parent_task_id: parentTask.id,
      task_ids: taskIds,
      config: netConfig,
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

    // Create Parent Task
    const parentTask = await Tasks.create({
      zone_name: 'system',
      operation: 'provisioning_network_teardown',
      priority: TaskPriority.NORMAL,
      created_by: createdBy,
      status: 'running', // Start immediately as a container
      metadata: JSON.stringify(netConfig),
    });

    // Helper to create chained tasks
    const queueTask = async (operation, metadata) => {
      const task = await Tasks.create({
        zone_name: 'system',
        operation,
        priority: TaskPriority.HIGH,
        created_by: createdBy,
        status: 'pending',
        parent_task_id: parentTask.id,
        depends_on: lastTaskId,
        metadata: await new Promise(resolve => {
          yj.stringifyAsync(metadata, (err, result) => {
            void err;
            resolve(result);
          });
        }),
      });
      lastTaskId = task.id;
      taskIds.push(task.id);
      return task;
    };

    // 1. Stop DHCP Service
    await queueTask('dhcp_service_control', { action: 'stop' });

    // 2. Remove the NAT rule setup created (found by subnet in the NAT rules
    // database — setup's create_nat_rule stored it). Skipping this orphaned an
    // ipnat.conf rule on every setup/teardown cycle.
    const natRule = await NatRules.findOne({ where: { subnet: netConfig.subnet } });
    if (natRule) {
      await queueTask('delete_nat_rule', { rule_id: natRule.id });
    }

    // 3. Disable forwarding on the interconnect ONLY — global forwarding and
    // the external bridge stay untouched (other consumers may depend on them).
    if (await componentExists('vnic', netConfig.host_vnic_name)) {
      await queueTask('configure_forwarding', {
        enabled: false,
        interfaces: [netConfig.host_vnic_name],
        global: false,
      });
    }

    // 4. Remove IP Address
    const addrobj = `${netConfig.host_vnic_name}/v4static`;
    if (await componentExists('ip', addrobj)) {
      await queueTask('delete_ip_address', { addrobj });
    }

    // 5. Remove VNIC
    if (await componentExists('vnic', netConfig.host_vnic_name)) {
      await queueTask('delete_vnic', { vnic: netConfig.host_vnic_name });
    }

    // 6. Remove Etherstub
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
