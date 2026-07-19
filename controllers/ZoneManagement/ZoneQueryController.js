import Zones from '../../models/ZoneModel.js';
import Tasks from '../../models/TaskModel.js';
import VncSessions from '../../models/VncSessionModel.js';
import { executeCommand } from '../../lib/CommandManager.js';
import {
  getZoneConfig as fetchZoneConfig,
  overlayDocumentSections,
  readZonecfgAttr,
} from '../../lib/ZoneConfigUtils.js';
import { effectiveRemoveOnCompletion } from '../../lib/ProvisioningNetwork.js';
import { isGuestAgentEnabled, hasGuestAgentChannel } from '../../lib/QemuGuestAgent.js';
import { errorResponse } from '../SystemHostController/utils/ResponseHelpers.js';
import { log } from '../../lib/Logger.js';
import { validateZoneName } from '../../lib/ZoneValidation.js';

/**
 * @fileoverview Zone query controllers - list, details, config retrieval
 */

/**
 * The zonecfg net-resource keys that are NOT brand properties — everything
 * else on a net resource is a bhyve backend prop (promiscphys, vqsize, …).
 */
const NET_RESOURCE_KEYS = new Set([
  'physical',
  'global-nic',
  'global_nic',
  'vlan-id',
  'vlan_id',
  'mac-addr',
  'mac_addr',
  'allowed-address',
  'allowed_address',
  'address',
  'defrouter',
  'over',
]);

/**
 * Extract the brand props set on one zadm `net` resource, robust to how zadm
 * renders them (not host-verified, so handle both shapes it plausibly emits):
 *   - flat scalar keys on the net object (promiscphys: "on", vqsize: "1024"),
 *   - and/or a `property`/`properties` array of {name, value} (the raw zonecfg
 *     `add property (name=…,value=…)` shape).
 * Only SCALAR values become props — a nested object/array is never leaked as if
 * it were a property value, so an unexpected rendering yields an empty/partial
 * props map rather than garbage.
 * @param {Object} net - One net resource from the zadm view
 * @returns {Object} Brand props by name
 */
const extractNetProps = net => {
  const props = {};
  const isScalar = value =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

  for (const [key, value] of Object.entries(net)) {
    if (key === 'property' || key === 'properties') {
      const entries = Array.isArray(value) ? value : [value];
      for (const prop of entries) {
        if (prop && typeof prop === 'object' && prop.name !== undefined && isScalar(prop.value)) {
          props[prop.name] = prop.value;
        }
      }
      continue;
    }
    if (!NET_RESOURCE_KEYS.has(key) && key !== 'netif' && isScalar(value)) {
      props[key] = value;
    }
  }
  return props;
};

/**
 * Build knob_current.nics — each NIC's effective netif and its CURRENTLY SET
 * brand props (the zonecfg net-resource properties bhyve's network backend
 * consumes). An unset prop is ABSENT here; what it runs with instead is
 * knob_defaults['nics.props.*'] on GET /machines/defaults, and which props
 * apply to a given backend is nic_props_by_netif there.
 *
 * These are NOT dladm link properties — MAC/IP spoofing lives in the dladm
 * `protection` prop (GET/PUT /network/vnics/{vnic}/properties).
 * @param {Object} configuration - Live zone configuration (zadm view)
 * @returns {Array<{physical: string, netif: string|undefined, props: Object}>}
 */
const buildNicKnobCurrent = configuration => {
  const nets = Array.isArray(configuration?.net) ? configuration.net : [];
  // The overlaid document's networks[] pairs with the net resources BY INDEX
  // (the declared pairing rule — the recipe variable builder's own mapping):
  // the UI badges/locks the provisioning transport NIC off this marker.
  const docNetworks = Array.isArray(configuration?.networks) ? configuration.networks : [];
  return nets
    .map((net, index) => {
      if (!net) {
        return null;
      }
      const entry = { physical: net.physical, props: extractNetProps(net) };
      // The per-NIC netif overrides the zone-level netif attr; when neither is
      // set the brand default applies (knob_defaults['zones.netif']).
      const netif = net.netif || configuration?.netif;
      if (netif) {
        entry.netif = netif;
      }
      if (docNetworks[index]?.provisional === true) {
        entry.provisional = true;
        // The EFFECTIVE remove-on-completion beside the marker (converged
        // wire for the UI's post-create toggle): the entry's own flag, else
        // this agent's ruled default (remove).
        entry.remove_on_completion = effectiveRemoveOnCompletion(docNetworks[index]);
      }
      return entry;
    })
    .filter(Boolean);
};

/**
 * Parse the zone's vcpus attr into structured CPU topology (the
 * structured-JSON ruling — the UI never regex-parses raw attr strings).
 * bhyve(7) grammar: [cpus=]numcpus[,sockets=s][,cores=c][,threads=t];
 * unspecified topology parameters run as 1. A plain count (no topology
 * tokens) answers null.
 * @param {string|number|undefined} vcpus - The zadm view's vcpus value
 * @returns {{sockets: number, cores: number, threads: number}|null}
 */
const parseCpuTopology = vcpus => {
  if (typeof vcpus !== 'string' || !vcpus.includes('=')) {
    return null;
  }
  const read = key => {
    const match = new RegExp(`(?:^|,)${key}=(\\d+)`, 'u').exec(vcpus);
    return match ? Number(match[1]) : null;
  };
  const sockets = read('sockets');
  const cores = read('cores');
  const threads = read('threads');
  if (sockets === null && cores === null && threads === null) {
    return null;
  }
  return { sockets: sockets ?? 1, cores: cores ?? 1, threads: threads ?? 1 };
};

/**
 * Get current zone status from system using CommandManager
 * @param {string} zoneName - Name of the zone
 * @returns {Promise<string>} Zone status
 */
export const getSystemZoneStatus = async zoneName => {
  const result = await executeCommand(`pfexec zoneadm -z ${zoneName} list -p`);

  if (result.success) {
    const parts = result.output.split(':');
    return parts[2] || 'unknown';
  }
  return 'not_found';
};

/**
 * @swagger
 * /machines:
 *   get:
 *     summary: List all machines
 *     description: Retrieves a list of all machines (zones) with their current status and metadata
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [configured, incomplete, installed, ready, running, shutting_down, down]
 *         description: Filter machines by status
 *       - in: query
 *         name: tag
 *         schema:
 *           type: string
 *         description: Filter machines by tag (machines must contain this tag)
 *       - in: query
 *         name: orphaned
 *         schema:
 *           type: boolean
 *         description: Include orphaned machines
 *     responses:
 *       200:
 *         description: List of machines retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 machines:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Zone'
 *                 total:
 *                   type: integer
 *                   description: Total number of machines
 *       500:
 *         description: Failed to retrieve machines
 */
export const listZones = async (req, res) => {
  try {
    const { status, orphaned, tag } = req.query;
    const whereClause = {};

    if (status) {
      whereClause.status = status;
    }

    if (orphaned !== undefined) {
      whereClause.is_orphaned = orphaned === 'true';
    }

    let zones = await Zones.findAll({
      where: whereClause,
      order: [['name', 'ASC']],
    });

    if (tag) {
      zones = zones.filter(zone => {
        const zoneTags = zone.tags || [];
        return Array.isArray(zoneTags) && zoneTags.includes(tag);
      });
    }

    return res.json({
      machines: zones,
      total: zones.length,
    });
  } catch (error) {
    log.database.error('Database error listing zones', {
      error: error.message,
      query_params: req.query,
    });
    return res.status(500).json({ error: 'Failed to retrieve zones' });
  }
};

/**
 * @swagger
 * /machines/{machineName}:
 *   get:
 *     summary: Get machine details
 *     description: Retrieves detailed information about a specific machine (zone) including full configuration
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine
 *     responses:
 *       200:
 *         description: Machine details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 machine_info:
 *                   $ref: '#/components/schemas/Zone'
 *                 configuration:
 *                   type: object
 *                   description: Full zone configuration from zadm
 *                 active_vnc_session:
 *                   $ref: '#/components/schemas/VncSession'
 *                 pending_tasks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Task'
 *                 pending_changes:
 *                   type: object
 *                   nullable: true
 *                   description: Accrued modify changes awaiting the next agent-driven power cycle (null when none)
 *                 knob_current:
 *                   type: object
 *                   description: |
 *                     Live per-knob current state (shared prefill contract with the Go
 *                     agent). A key is present only when it has a real answer.
 *                   properties:
 *                     guest_agent:
 *                       type: boolean
 *                       description: Whether the zone's configuration carries the virtio-console qga channel (key present only while guest_agent.enabled is on)
 *                     vnc:
 *                       type: string
 *                       description: The RAW zonecfg vnc attr string — exactly the PUT vocabulary (on/off/wait/options string); key absent when the attr is unset (brand default off)
 *                       example: "on"
 *                     bootorder:
 *                       type: array
 *                       items:
 *                         type: string
 *                       description: The zonecfg bootorder attr parsed into device tokens (join with commas to rebuild the PUT string); key absent when the attr is unset — the brand then runs its documented default path0,bootdisk,cdrom0 (knob_defaults['zones.bootorder'], per bhyve(7) https://man.omnios.org/man7/bhyve)
 *                       example: ["cdrom0", "bootdisk"]
 *                     boot_priority:
 *                       type: integer
 *                       description: Orchestration boot/shutdown priority (custom zonecfg attr); key absent when unset — effective default 95
 *                       example: 50
 *                     consoleport:
 *                       type: integer
 *                       description: Pinned noVNC web-console port (custom zonecfg attr); key absent when unset — the dynamic pool applies
 *                       example: 6001
 *                     consolehost:
 *                       type: string
 *                       description: noVNC web-console bind address (custom zonecfg attr); key absent when unset — 0.0.0.0 applies
 *                       example: "127.0.0.1"
 *                     cpu_topology:
 *                       type: object
 *                       nullable: true
 *                       description: |
 *                         Structured CPU topology parsed from the zone's vcpus attr
 *                         (bhyve(7) grammar; unspecified parameters run as 1) — null
 *                         when vcpus is a plain count. The UI renders this, never the
 *                         raw sockets=,cores=,threads= string.
 *                       properties:
 *                         sockets:
 *                           type: integer
 *                         cores:
 *                           type: integer
 *                         threads:
 *                           type: integer
 *                     nics:
 *                       type: array
 *                       description: |
 *                         Per-NIC brand properties CURRENTLY SET (the zonecfg net-resource
 *                         properties bhyve's network backend consumes). An unset prop is
 *                         ABSENT — what it runs with instead is knob_defaults['nics.props.*']
 *                         on GET /machines/defaults, and which props apply to a NIC's backend
 *                         is nic_props_by_netif there. NOT dladm link properties: MAC/IP
 *                         spoofing is the dladm `protection` prop
 *                         (GET/PUT /network/vnics/{vnic}/properties).
 *                       items:
 *                         type: object
 *                         properties:
 *                           physical:
 *                             type: string
 *                             example: "vnice3_8009_0"
 *                           netif:
 *                             type: string
 *                             description: Effective backend (per-NIC netif, else the zone-level netif attr); absent when neither is set — the brand default applies
 *                             example: "virtio-net-viona"
 *                           provisional:
 *                             type: boolean
 *                             description: Present (true) when this NIC is the provisioning transport — the document's networks[] entry AT THE SAME INDEX carries provisional true (the declared pairing rule); the UI badges it and locks its dhcp4/is_control against hand-edits
 *                           remove_on_completion:
 *                             type: boolean
 *                             description: Present on provisional rows only — the EFFECTIVE remove-on-completion (entry flag, else this agent's ruled default REMOVE). Flip it via PUT update_nics entries carrying remove_on_completion
 *                           props:
 *                             type: object
 *                             description: Brand props explicitly set on this NIC
 *                             example: { "promiscphys": "on" }
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to retrieve zone details
 */
export const getZoneDetails = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    // Get current system status
    const currentStatus = await getSystemZoneStatus(zoneName);

    // Update database if status changed
    if (currentStatus !== zone.status && currentStatus !== 'not_found') {
      await zone.update({
        status: currentStatus,
        last_seen: new Date(),
        is_orphaned: false,
      });
    } else if (currentStatus === 'not_found') {
      await zone.update({ is_orphaned: true });
    }

    // Get all data in parallel for optimal performance (fixes slow frontend loading)
    const [configuration, vncSession, pendingTasks] = await Promise.all([
      // Get zone configuration using shared utility
      fetchZoneConfig(zoneName).catch(error => {
        log.monitoring.error('Failed to get zone configuration', {
          zone_name: zoneName,
          error: error.message,
        });
        return {};
      }),

      // Get VNC session
      VncSessions.findOne({
        where: { zone_name: zoneName, status: 'active' },
      }).catch(error => {
        log.database.warn('Failed to get VNC session for zone', {
          zone_name: zoneName,
          error: error.message,
        });
        return null;
      }),

      // Get pending tasks
      Tasks.findAll({
        where: {
          zone_name: zoneName,
          status: ['pending', 'running'],
        },
        order: [['created_at', 'DESC']],
        limit: 10,
      }).catch(error => {
        log.database.warn('Failed to get tasks for zone', {
          zone_name: zoneName,
          error: error.message,
        });
        return [];
      }),

      // Refresh zone data after potential update
      zone.reload(),
    ]);

    // The document store is authoritative: overlay the DB-owned Hosts.yml
    // sections (settings/networks/disks/provisioner/…) onto the live zadm view
    // so the answered configuration always reflects the stored document.
    overlayDocumentSections(zone.configuration, configuration, zoneName);

    const pendingChanges =
      configuration.pending_changes && Object.keys(configuration.pending_changes).length > 0
        ? configuration.pending_changes
        : null;

    // Log configuration details if successfully loaded
    if (configuration && Object.keys(configuration).length > 0) {
      log.monitoring.debug('Zone configuration loaded successfully', {
        zone_name: zoneName,
        ram: configuration.ram,
        vcpus: configuration.vcpus,
        brand: configuration.brand,
      });
    }

    // Process VNC session data
    let activeVncSession = null;
    if (vncSession) {
      activeVncSession = vncSession.toJSON();
      activeVncSession.console_url = `${req.protocol}://${req.get('host')}/machines/${zoneName}/vnc/console`;
    }

    const detail = {
      machine_info: zone.toJSON(),
      configuration,
      active_vnc_session: activeVncSession,
      pending_tasks: pendingTasks,
      system_status: currentStatus,
      pending_changes: pendingChanges,
    };
    // knob_current (the Go agent's prefill contract, minimal mirror): a key
    // is present only when it has a real answer. guest_agent derives LIVE from
    // the zadm view while the guest-agent surface is enabled; vnc is the RAW
    // zonecfg attr string — exactly the PUT vocabulary, never zadm's
    // decomposed object (absent attr = key absent = brand default off).
    detail.knob_current = {};
    if (isGuestAgentEnabled()) {
      detail.knob_current.guest_agent = hasGuestAgentChannel(configuration);
    }
    const [vncAttr, bootorderAttr, bootPriorityAttr, consoleportAttr, consolehostAttr] =
      await Promise.all([
        readZonecfgAttr(zoneName, 'vnc'),
        readZonecfgAttr(zoneName, 'bootorder'),
        readZonecfgAttr(zoneName, 'boot_priority'),
        readZonecfgAttr(zoneName, 'consoleport'),
        readZonecfgAttr(zoneName, 'consolehost'),
      ]);
    if (vncAttr.exists) {
      detail.knob_current.vnc = vncAttr.value;
    }
    // bootorder as a parsed token list (comma-separated device tokens on the
    // wire); absent attr = key absent = the UEFI bootrom's own NVRAM order.
    if (bootorderAttr.exists) {
      detail.knob_current.bootorder = bootorderAttr.value
        .split(',')
        .map(token => token.trim())
        .filter(Boolean);
    }
    // Agent-owned custom attrs (the PUT boot_priority/consoleport/consolehost
    // knobs). Numeric knobs serve as numbers; key absent = attr unset
    // (boot_priority then defaults to 95, consoleport to the dynamic pool).
    if (bootPriorityAttr.exists && Number.isInteger(Number(bootPriorityAttr.value))) {
      detail.knob_current.boot_priority = Number(bootPriorityAttr.value);
    }
    if (consoleportAttr.exists && Number.isInteger(Number(consoleportAttr.value))) {
      detail.knob_current.consoleport = Number(consoleportAttr.value);
    }
    if (consolehostAttr.exists && consolehostAttr.value) {
      detail.knob_current.consolehost = consolehostAttr.value;
    }
    detail.knob_current.nics = buildNicKnobCurrent(configuration);
    detail.knob_current.cpu_topology = parseCpuTopology(configuration?.vcpus);
    return res.json(detail);
  } catch (error) {
    log.database.error('Database error getting zone details', {
      error: error.message,
      zone_name: req.params.machineName,
    });
    return res.status(500).json({ error: 'Failed to retrieve zone details' });
  }
};

/**
 * @swagger
 * /machines/{machineName}/config:
 *   get:
 *     summary: Get machine configuration
 *     description: Retrieves the complete machine (zone) configuration using zadm show
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine
 *     responses:
 *       200:
 *         description: Machine configuration retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 machine_name:
 *                   type: string
 *                 configuration:
 *                   type: object
 *                   description: Complete zone configuration from zadm
 *       404:
 *         description: Machine not found
 *       500:
 *         description: Failed to retrieve machine configuration
 */
export const getZoneConfig = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return errorResponse(res, 400, 'Invalid zone name');
    }

    // Get zone configuration using shared utility
    const zoneConfig = await fetchZoneConfig(zoneName);

    // Overlay the DB-owned document sections — same authority rule as
    // GET /machines/{name}: the document store wins over zadm output.
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (zone) {
      overlayDocumentSections(zone.configuration, zoneConfig, zoneName);
    }

    return res.json({
      machine_name: zoneName,
      configuration: zoneConfig,
    });
  } catch (error) {
    log.monitoring.error('Error getting zone config', {
      error: error.message,
      zone_name: req.params.machineName,
    });

    // Check if it's a "zone does not exist" error
    if (error.message && error.message.includes('does not exist')) {
      return errorResponse(res, 404, 'Zone not found');
    }

    return errorResponse(res, 500, 'Failed to retrieve zone configuration', error.message);
  }
};
