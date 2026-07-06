/**
 * @fileoverview NAT and IP Forwarding Management Controller for Zoneweaver Agent
 * @description Handles NAT rule management via ipnat/ipfilter and IP forwarding via routeadm/ipadm
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../lib/Logger.js';
import NatRules from '../models/NatRuleModel.js';

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
 * @swagger
 * /network/nat/rules:
 *   get:
 *     summary: List NAT rules
 *     description: Returns current NAT rules from ipnat and the ipnat.conf configuration file
 *     tags: [NAT Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: NAT rules retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 active_rules:
 *                   type: string
 *                   nullable: true
 *                   description: Raw `ipnat -l` output of active kernel NAT rules
 *                 configured_rules:
 *                   type: array
 *                   description: Persisted NAT rules from the database (each item has id, rule, and the NatRule columns)
 *                   items:
 *                     type: object
 *                 config_file:
 *                   type: string
 *                   example: /etc/ipf/ipnat.conf
 *       500:
 *         description: Failed to retrieve NAT rules
 */
export const getNatRules = async (req, res) => {
  void req;
  try {
    // Get active NAT rules from kernel
    const activeResult = await executeCommand('pfexec ipnat -l');

    // Get configured rules from Database
    // Note: We assume the TaskManager keeps DB in sync.
    // If we want absolute freshness, we could trigger a sync task here, but that's slow.
    // For listing, DB read is standard.
    const dbRules = await NatRules.findAll();

    const rules = dbRules.map(r => ({
      id: r.id, // UUID
      rule: r.raw_rule,
      ...r.toJSON(),
    }));

    return res.json({
      active_rules: activeResult.success ? activeResult.output : null,
      configured_rules: rules,
      config_file: '/etc/ipf/ipnat.conf',
    });
  } catch (error) {
    log.api.error('Failed to get NAT rules', { error: error.message });
    return res.status(500).json({ error: 'Failed to retrieve NAT rules', details: error.message });
  }
};

/**
 * @swagger
 * /network/nat/rules:
 *   post:
 *     summary: Create NAT rule
 *     description: Adds a NAT rule to /etc/ipf/ipnat.conf and refreshes the ipfilter service
 *     tags: [NAT Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bridge, subnet]
 *             properties:
 *               bridge:
 *                 type: string
 *                 description: External interface for NAT (e.g., igb0)
 *                 example: "igb0"
 *               subnet:
 *                 type: string
 *                 description: Source subnet to NAT (e.g., 10.190.190.0/24)
 *                 example: "10.190.190.0/24"
 *               target:
 *                 type: string
 *                 description: Target address mapping
 *                 default: "0/32"
 *                 example: "0/32"
 *               protocol:
 *                 type: string
 *                 description: Protocol for portmap
 *                 default: "tcp/udp"
 *                 example: "tcp/udp"
 *               type:
 *                 type: string
 *                 description: NAT type
 *                 default: "portmap"
 *                 enum: [portmap, bimap, rdr]
 *                 example: "portmap"
 *     responses:
 *       202:
 *         description: NAT rule creation task queued
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Failed to queue NAT rule creation
 */
export const createNatRule = async (req, res) => {
  try {
    const { bridge, subnet, target = '0/32', protocol = 'tcp/udp', type = 'portmap' } = req.body;

    if (!bridge || !subnet) {
      return res.status(400).json({ error: 'bridge and subnet are required' });
    }

    const metadata = { bridge, subnet, target, protocol, type };

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'create_nat_rule',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(metadata, (err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        });
      }),
    });

    return res.status(202).json({
      success: true,
      message: `NAT rule creation task queued for ${bridge} (${subnet})`,
      task_id: task.id,
      bridge,
      subnet,
    });
  } catch (error) {
    log.api.error('Failed to create NAT rule task', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Failed to queue NAT rule creation', details: error.message });
  }
};

/**
 * @swagger
 * /network/nat/rules/{ruleId}:
 *   delete:
 *     summary: Delete NAT rule
 *     description: Removes a NAT rule from /etc/ipf/ipnat.conf by UUID and refreshes ipfilter
 *     tags: [NAT Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: ruleId
 *         required: true
 *         schema:
 *           type: string
 *         description: Rule UUID
 *     responses:
 *       202:
 *         description: NAT rule deletion task queued
 *       400:
 *         description: Invalid rule ID
 *       500:
 *         description: Failed to queue NAT rule deletion
 */
export const deleteNatRule = async (req, res) => {
  try {
    const { ruleId } = req.params;
    if (!ruleId) {
      return res.status(400).json({ error: 'Rule ID is required' });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'delete_nat_rule',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync({ rule_id: ruleId }, (err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        });
      }),
    });

    return res.status(202).json({
      success: true,
      message: `NAT rule deletion task queued for rule ${ruleId}`,
      task_id: task.id,
      rule_id: ruleId,
    });
  } catch (error) {
    log.api.error('Failed to delete NAT rule task', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Failed to queue NAT rule deletion', details: error.message });
  }
};

/**
 * @swagger
 * /network/nat/status:
 *   get:
 *     summary: Get ipfilter service status
 *     description: Returns the status of the network/ipfilter SMF service
 *     tags: [NAT Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: ipfilter status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 service:
 *                   type: string
 *                   example: network/ipfilter
 *                 state:
 *                   type: string
 *                   description: SMF service state (e.g. online, disabled, maintenance, unknown)
 *                 since:
 *                   type: string
 *                   nullable: true
 *                   description: Service state timestamp (stime) from svcs
 *                 raw:
 *                   type: string
 *                   nullable: true
 *                   description: Raw svcs output line
 *       500:
 *         description: Failed to get ipfilter status
 */
export const getNatStatus = async (req, res) => {
  void req;
  try {
    const result = await executeCommand('svcs -H -o state,stime network/ipfilter');

    let state = 'unknown';
    let since = null;
    if (result.success && result.output) {
      const parts = result.output.trim().split(/\s+/);
      state = parts[0] || 'unknown';
      since = parts[1] || null;
    }

    return res.json({
      service: 'network/ipfilter',
      state,
      since,
      raw: result.output || null,
    });
  } catch (error) {
    log.api.error('Failed to get ipfilter status', { error: error.message });
    return res.status(500).json({ error: 'Failed to get ipfilter status', details: error.message });
  }
};

/**
 * @swagger
 * /network/forwarding:
 *   get:
 *     summary: Get IP forwarding status
 *     description: Returns IP forwarding configuration from routeadm
 *     tags: [NAT Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: IP forwarding status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 forwarding:
 *                   type: object
 *                   properties:
 *                     ipv4:
 *                       type: object
 *                       properties:
 *                         current:
 *                           type: string
 *                         persistent:
 *                           type: string
 *                     ipv6:
 *                       type: object
 *                       properties:
 *                         current:
 *                           type: string
 *                         persistent:
 *                           type: string
 *                 interfaces:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       interface:
 *                         type: string
 *                       current:
 *                         type: string
 *                       persistent:
 *                         type: string
 *                 raw:
 *                   type: string
 *                   nullable: true
 *                   description: Raw `routeadm -p` output
 *       500:
 *         description: Failed to get forwarding status
 */
export const getForwardingStatus = async (req, res) => {
  void req;
  try {
    const result = await executeCommand('pfexec routeadm -p');

    const forwarding = {
      ipv4: { current: 'unknown', persistent: 'unknown' },
      ipv6: { current: 'unknown', persistent: 'unknown' },
    };

    if (result.success && result.output) {
      const lines = result.output.split('\n');
      for (const line of lines) {
        if (line.includes('ipv4-forwarding')) {
          forwarding.ipv4.persistent = line.includes('persistent=enabled') ? 'enabled' : 'disabled';
          forwarding.ipv4.current = line.includes('current=enabled') ? 'enabled' : 'disabled';
        }
        if (line.includes('ipv6-forwarding')) {
          forwarding.ipv6.persistent = line.includes('persistent=enabled') ? 'enabled' : 'disabled';
          forwarding.ipv6.current = line.includes('current=enabled') ? 'enabled' : 'disabled';
        }
      }
    }

    // Get per-interface forwarding status
    const ifResult = await executeCommand(
      'pfexec ipadm show-ifprop -p forwarding -co ifname,current,persistent 2>/dev/null'
    );
    const interfaces = [];
    if (ifResult.success && ifResult.output) {
      for (const line of ifResult.output.split('\n')) {
        const parts = line.trim().split(':');
        if (parts.length >= 3) {
          interfaces.push({
            interface: parts[0],
            current: parts[1],
            persistent: parts[2],
          });
        }
      }
    }

    return res.json({
      forwarding,
      interfaces,
      raw: result.output || null,
    });
  } catch (error) {
    log.api.error('Failed to get forwarding status', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Failed to get forwarding status', details: error.message });
  }
};

/**
 * @swagger
 * /network/forwarding:
 *   put:
 *     summary: Configure IP forwarding
 *     description: |
 *       Enable or disable IP forwarding globally and/or on specific interfaces.
 *       Uses routeadm for global forwarding and ipadm for per-interface forwarding.
 *     tags: [NAT Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled:
 *                 type: boolean
 *                 description: Enable or disable global IPv4 forwarding
 *                 example: true
 *               interfaces:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Interfaces to enable/disable forwarding on
 *                 example: ["igb0", "provision_interconnect0"]
 *     responses:
 *       202:
 *         description: Forwarding configuration task queued
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Failed to queue forwarding configuration
 */
export const configureForwarding = async (req, res) => {
  try {
    const { enabled, interfaces } = req.body;

    if (enabled === undefined && (!interfaces || interfaces.length === 0)) {
      return res.status(400).json({ error: 'enabled or interfaces must be specified' });
    }

    const metadata = { enabled, interfaces };

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'configure_forwarding',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(metadata, (err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        });
      }),
    });

    return res.status(202).json({
      success: true,
      message: 'IP forwarding configuration task queued',
      task_id: task.id,
      enabled,
      interfaces,
    });
  } catch (error) {
    log.api.error('Failed to configure forwarding', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Failed to queue forwarding configuration', details: error.message });
  }
};
