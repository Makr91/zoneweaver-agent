/**
 * @fileoverview DHCP Server Management Controller for Zoneweaver Agent
 * @description Manages ISC DHCP server configuration, static host entries, and service lifecycle
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../lib/Logger.js';
import DhcpHosts from '../models/DhcpHostModel.js';

const execPromise = util.promisify(exec);

const DHCPD_CONF_PATH = '/etc/dhcpd.conf';

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
 * Parse dhcpd.conf into a structured object
 * @returns {Promise<{subnets: Array, hosts: Array, raw: string}>}
 */
const parseDhcpdConf = async () => {
  const result = await executeCommand(`cat ${DHCPD_CONF_PATH} 2>/dev/null`);
  const subnets = [];
  const hosts = [];
  const raw = result.success ? result.output : '';

  if (!result.success || !result.output) {
    return { subnets, hosts, raw };
  }

  const content = result.output;

  // Parse subnet blocks
  const subnetRegex = /subnet\s+(?<subnet>\S+)\s+netmask\s+(?<netmask>\S+)\s*\{(?<block>[^}]*)}/gs;
  let match;
  while ((match = subnetRegex.exec(content)) !== null) {
    const subnet = { subnet: match.groups.subnet, netmask: match.groups.netmask, options: {} };
    const { block } = match.groups;

    const optionMatch = block.match(/option\s+routers\s+(?<routers>[^;]+);/);
    if (optionMatch) {
      subnet.options.routers = optionMatch.groups.routers.trim();
    }

    const rangeMatch = block.match(/range\s+(?<start>\S+)\s+(?<end>\S+);/);
    if (rangeMatch) {
      subnet.range_start = rangeMatch.groups.start;
      subnet.range_end = rangeMatch.groups.end;
    }

    const dnsMatch = block.match(/option\s+domain-name-servers\s+(?<dns>[^;]+);/);
    if (dnsMatch) {
      subnet.options.dns = dnsMatch.groups.dns.trim();
    }

    subnets.push(subnet);
  }

  // Parse host blocks
  const hostRegex = /host\s+(?<hostname>\S+)\s*\{(?<block>[^}]*)}/gs;
  while ((match = hostRegex.exec(content)) !== null) {
    const host = { hostname: match.groups.hostname };
    const { block } = match.groups;

    const macMatch = block.match(/hardware\s+ethernet\s+(?<mac>[^;]+);/);
    if (macMatch) {
      host.mac = macMatch.groups.mac.trim();
    }

    const ipMatch = block.match(/fixed-address\s+(?<ip>[^;]+);/);
    if (ipMatch) {
      host.ip = ipMatch.groups.ip.trim();
    }

    hosts.push(host);
  }

  return { subnets, hosts, raw };
};

/**
 * @swagger
 * /network/dhcp/config:
 *   get:
 *     summary: Get DHCP server configuration
 *     description: Returns the parsed DHCP server configuration from dhcpd.conf
 *     tags: [DHCP Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: DHCP configuration retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 config_file:
 *                   type: string
 *                   example: /etc/dhcpd.conf
 *                 subnets:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       subnet:
 *                         type: string
 *                       netmask:
 *                         type: string
 *                       range_start:
 *                         type: string
 *                       range_end:
 *                         type: string
 *                       options:
 *                         type: object
 *                         properties:
 *                           routers:
 *                             type: string
 *                           dns:
 *                             type: string
 *                 hosts:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       hostname:
 *                         type: string
 *                       mac:
 *                         type: string
 *                       ip:
 *                         type: string
 *       500:
 *         description: Failed to retrieve DHCP configuration
 */
export const getDhcpConfig = async (req, res) => {
  void req;
  try {
    const config = await parseDhcpdConf();
    return res.json({
      config_file: DHCPD_CONF_PATH,
      subnets: config.subnets,
      hosts: config.hosts,
    });
  } catch (error) {
    log.api.error('Failed to get DHCP config', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Failed to retrieve DHCP configuration', details: error.message });
  }
};

/**
 * @swagger
 * /network/dhcp/config:
 *   put:
 *     summary: Update DHCP server configuration
 *     description: Updates the DHCP subnet configuration and refreshes the DHCP service
 *     tags: [DHCP Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [subnet, netmask, router, range_start, range_end]
 *             properties:
 *               subnet:
 *                 type: string
 *                 example: "10.190.190.0"
 *               netmask:
 *                 type: string
 *                 example: "255.255.255.0"
 *               router:
 *                 type: string
 *                 example: "10.190.190.1"
 *               range_start:
 *                 type: string
 *                 example: "10.190.190.10"
 *               range_end:
 *                 type: string
 *                 example: "10.190.190.254"
 *               dns:
 *                 type: string
 *                 description: Comma-separated DNS servers
 *                 example: "8.8.8.8, 8.8.4.4"
 *               listen_interface:
 *                 type: string
 *                 description: Interface for DHCP to listen on
 *                 example: "provisioning_0"
 *     responses:
 *       202:
 *         description: DHCP config update task queued
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Failed to queue DHCP config update
 */
export const updateDhcpConfig = async (req, res) => {
  try {
    const { subnet, netmask, router, range_start, range_end, dns, listen_interface } = req.body;

    if (!subnet || !netmask || !router || !range_start || !range_end) {
      return res
        .status(400)
        .json({ error: 'subnet, netmask, router, range_start, and range_end are required' });
    }

    const metadata = { subnet, netmask, router, range_start, range_end, dns, listen_interface };

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'dhcp_update_config',
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
      message: 'DHCP configuration update task queued',
      task_id: task.id,
      subnet,
      netmask,
    });
  } catch (error) {
    log.api.error('Failed to update DHCP config', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Failed to queue DHCP config update', details: error.message });
  }
};

/**
 * @swagger
 * /network/dhcp/hosts:
 *   get:
 *     summary: List DHCP static host entries
 *     description: Returns all static host entries (MAC to IP mappings) from dhcpd.conf
 *     tags: [DHCP Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: DHCP hosts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 hosts:
 *                   type: array
 *                   description: Persisted DHCP static host entries (DhcpHost rows)
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *       500:
 *         description: Failed to retrieve DHCP hosts
 */
export const getDhcpHosts = async (req, res) => {
  void req;
  try {
    const hosts = await DhcpHosts.findAll();
    return res.json({
      hosts,
      total: hosts.length,
    });
  } catch (error) {
    log.api.error('Failed to get DHCP hosts', { error: error.message });
    return res.status(500).json({ error: 'Failed to retrieve DHCP hosts', details: error.message });
  }
};

/**
 * @swagger
 * /network/dhcp/hosts:
 *   post:
 *     summary: Add DHCP static host entry
 *     description: Adds a static host entry (MAC to IP mapping) to dhcpd.conf
 *     tags: [DHCP Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [hostname, mac, ip]
 *             properties:
 *               hostname:
 *                 type: string
 *                 description: Host identifier
 *                 example: "web-server-01"
 *               mac:
 *                 type: string
 *                 description: MAC address
 *                 example: "aa:bb:cc:dd:ee:ff"
 *               ip:
 *                 type: string
 *                 description: Fixed IP address
 *                 example: "10.190.190.10"
 *     responses:
 *       202:
 *         description: DHCP host creation task queued
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Failed to queue DHCP host creation
 */
export const addDhcpHost = async (req, res) => {
  try {
    const { hostname, mac, ip } = req.body;

    if (!hostname || !mac || !ip) {
      return res.status(400).json({ error: 'hostname, mac, and ip are required' });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'dhcp_add_host',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync({ hostname, mac, ip }, (err, result) => {
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
      message: `DHCP host entry task queued for ${hostname}`,
      task_id: task.id,
      hostname,
      mac,
      ip,
    });
  } catch (error) {
    log.api.error('Failed to add DHCP host', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Failed to queue DHCP host creation', details: error.message });
  }
};

/**
 * @swagger
 * /network/dhcp/hosts/{hostname}:
 *   delete:
 *     summary: Remove DHCP static host entry
 *     description: Removes a static host entry from dhcpd.conf by hostname
 *     tags: [DHCP Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: hostname
 *         required: true
 *         schema:
 *           type: string
 *         description: Hostname of the DHCP entry to remove
 *     responses:
 *       202:
 *         description: DHCP host deletion task queued
 *       400:
 *         description: Invalid hostname
 *       500:
 *         description: Failed to queue DHCP host deletion
 */
export const removeDhcpHost = async (req, res) => {
  try {
    const { hostname } = req.params;

    if (!hostname) {
      return res.status(400).json({ error: 'hostname is required' });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'dhcp_remove_host',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync({ hostname }, (err, result) => {
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
      message: `DHCP host removal task queued for ${hostname}`,
      task_id: task.id,
      hostname,
    });
  } catch (error) {
    log.api.error('Failed to remove DHCP host', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Failed to queue DHCP host removal', details: error.message });
  }
};

/**
 * @swagger
 * /network/dhcp/status:
 *   get:
 *     summary: Get DHCP service status
 *     description: Returns the status of the ISC DHCP server SMF service
 *     tags: [DHCP Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: DHCP service status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 service:
 *                   type: string
 *                   example: network/service/dhcp:ipv4
 *                 state:
 *                   type: string
 *                   description: SMF service state (e.g. online, disabled, unknown)
 *                 since:
 *                   type: string
 *                   nullable: true
 *                 listen_interface:
 *                   type: string
 *                   nullable: true
 *                   description: Configured DHCP listen interface (config/listen_ifnames)
 *       500:
 *         description: Failed to get DHCP service status
 */
export const getDhcpStatus = async (req, res) => {
  void req;
  try {
    const result = await executeCommand(
      'svcs -H -o state,stime network/service/dhcp:ipv4 2>/dev/null'
    );

    let state = 'unknown';
    let since = null;
    if (result.success && result.output) {
      [state = 'unknown', since = null] = result.output.trim().split(/\s+/);
    }

    // Get listen interface config
    const listenResult = await executeCommand(
      'svccfg -s network/service/dhcp:ipv4 listprop config/listen_ifnames 2>/dev/null'
    );
    let listenInterface = null;
    if (listenResult.success && listenResult.output) {
      const parts = listenResult.output.split(/\s+/);
      listenInterface = parts[parts.length - 1] || null;
    }

    return res.json({
      service: 'network/service/dhcp:ipv4',
      state,
      since,
      listen_interface: listenInterface,
    });
  } catch (error) {
    log.api.error('Failed to get DHCP status', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Failed to get DHCP service status', details: error.message });
  }
};

/**
 * @swagger
 * /network/dhcp/status:
 *   put:
 *     summary: Control DHCP service
 *     description: Start, stop, or refresh the DHCP service
 *     tags: [DHCP Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action]
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [start, stop, refresh, restart]
 *                 description: Service action to perform
 *                 example: "refresh"
 *     responses:
 *       202:
 *         description: DHCP service action task queued
 *       400:
 *         description: Invalid action
 *       500:
 *         description: Failed to queue DHCP service action
 */
export const controlDhcpService = async (req, res) => {
  try {
    const { action } = req.body;

    if (!action || !['start', 'stop', 'refresh', 'restart'].includes(action)) {
      return res
        .status(400)
        .json({ error: 'action must be one of: start, stop, refresh, restart' });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'dhcp_service_control',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync({ action }, (err, result) => {
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
      message: `DHCP service ${action} task queued`,
      task_id: task.id,
      action,
    });
  } catch (error) {
    log.api.error('Failed to control DHCP service', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Failed to queue DHCP service action', details: error.message });
  }
};
