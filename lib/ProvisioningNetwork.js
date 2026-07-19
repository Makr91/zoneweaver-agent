/**
 * @fileoverview Provisioning-network transport for packaged creates
 * @description Mark's architecture (sync-converged 2026-07-18): a create that
 * names a provisioner gets the provisioning network ATTACHED by the agent —
 * ONE networks[] entry declared into the document (the normalizeDisks
 * pattern): a DHCP client entry on the interconnect etherstub, NO address.
 * The agent's own dhcpd allocates from its configured range (the dhcpd IS
 * the allocator — nobody picks IPs), and once the guest leases, the leased
 * address is written back into the document's provisional entry (document
 * honesty) — extractControlIP, the recipes, and the whole pipeline consume
 * it untouched. qga stays telemetry, never transport.
 */

import fs from 'fs';
import config from '../config/ConfigLoader.js';
import { executeCommand } from './CommandManager.js';
import { log } from './Logger.js';
import { getZoneConfig, parseConfiguration, setDocumentNetworkAddress } from './ZoneConfigUtils.js';
import Zones from '../models/ZoneModel.js';

/**
 * The effective provisioning-network configuration — THE one reader
 * (ProvisioningNetworkController and the create path share it). Fallbacks
 * match the settings schema + shipped config defaults exactly.
 * @returns {Object} Provisioning network config with defaults
 */
export const getProvisioningNetworkConfig = () => {
  const provConfig = config.get('provisioning') || {};
  const netConfig = provConfig.network || {};
  return {
    enabled: netConfig.enabled !== false,
    // dladm(8): datalink names must start with a letter and END WITH A
    // NUMBER — a name without a trailing digit is an invalid link name.
    etherstub_name: netConfig.etherstub_name || 'zwestub_0',
    host_vnic_name: netConfig.host_vnic_name || 'provisioning_0',
    subnet: netConfig.subnet || '10.190.190.0/24',
    host_ip: netConfig.host_ip || '10.190.190.1',
    netmask: netConfig.netmask || '255.255.255.0',
    dhcp_range_start: netConfig.dhcp_range_start || '10.190.190.10',
    dhcp_range_end: netConfig.dhcp_range_end || '10.190.190.254',
  };
};

/**
 * Declare the provisioning network into a packaged create body: ONE
 * networks[] entry — DHCP client on the interconnect (`bridge` carries the
 * etherstub, so the SAME networks[]→nics derivation the real entries ride
 * builds its zonecfg half; no special-cased nic). The wizard's per-create
 * `remove_transport_on_completion` signal (converged 2026-07-18) folds into
 * the entry as `remove_on_completion` — an absent signal writes NO key
 * (absent = this agent's ruled default: REMOVE). No-op when the
 * provisioning network is disabled or the document already carries a
 * provisional entry (the author spoke).
 * @param {Object} body - Create request body (mutated)
 * @returns {{attached: boolean}} Whether the entry was declared
 */
export const attachProvisioningNetwork = body => {
  const netConfig = getProvisioningNetworkConfig();
  if (!netConfig.enabled) {
    return { attached: false };
  }
  body.networks = Array.isArray(body.networks) ? body.networks : [];
  if (body.networks.some(net => net?.provisional === true)) {
    return { attached: false };
  }
  const entry = {
    type: 'internal',
    bridge: netConfig.etherstub_name,
    netmask: netConfig.netmask,
    gateway: netConfig.host_ip,
    dhcp4: true,
    dhcp6: false,
    is_control: true,
    provisional: true,
  };
  if (typeof body.remove_transport_on_completion === 'boolean') {
    entry.remove_on_completion = body.remove_transport_on_completion;
  }
  body.networks.push(entry);
  return { attached: true };
};

/**
 * This agent's ruled absent-flag default (Mark, explicit): zoneweaver
 * REMOVES the transport after the whole-walk stamp (datacenter model); Go
 * keeps (home/dev). One flag, one semantic, per-agent default.
 * @param {Object|null} entry - A networks[] entry
 * @returns {boolean} Effective remove-on-completion
 */
export const effectiveRemoveOnCompletion = entry =>
  entry?.remove_on_completion === undefined ? true : entry.remove_on_completion === true;

/** ISC dhcpd leases-file candidates (the OmniOS packaging spellings). */
const LEASES_PATHS = ['/var/db/dhcpd4.leases', '/var/db/dhcpd.leases'];

/** Canonical MAC spelling — dladm prints unpadded octets, dhcpd pads. */
const normalizeMac = mac =>
  String(mac)
    .toLowerCase()
    .split(':')
    .map(octet => octet.padStart(2, '0'))
    .join(':');

/**
 * Read the agent's OWN dhcpd leases and answer the newest lease for a MAC —
 * deterministic: this is the server's record of its own assignment, never a
 * guest interrogation. dhcpd appends, so the LAST matching block wins.
 * @param {string} mac - The VNIC MAC
 * @returns {Promise<string|null>} Leased IPv4 or null
 */
export const readLeaseByMac = async mac => {
  const wanted = normalizeMac(mac);
  const leaseRegex = /lease\s+(?<ip>\d+\.\d+\.\d+\.\d+)\s*\{(?<block>[^}]*)\}/gsu;

  // Both candidate spellings read concurrently; the FIRST path (in candidate
  // order) with a matching lease wins.
  const reads = await Promise.all(
    LEASES_PATHS.map(path =>
      fs.existsSync(path) ? executeCommand(`pfexec cat ${path}`) : Promise.resolve(null)
    )
  );
  for (const result of reads) {
    if (!result?.success) {
      continue;
    }
    // The /g regex is stateful — reset between files.
    leaseRegex.lastIndex = 0;
    let found = null;
    let match;
    while ((match = leaseRegex.exec(result.output)) !== null) {
      const macMatch = match.groups.block.match(/hardware\s+ethernet\s+(?<mac>[0-9a-fA-F:]+);/u);
      if (macMatch && normalizeMac(macMatch.groups.mac) === wanted) {
        found = match.groups.ip;
      }
    }
    if (found) {
      return found;
    }
  }
  return null;
};

/**
 * The zone's provisional VNIC MAC: the document's provisional entry pairs
 * with the zadm net resource AT THE SAME INDEX (the declared pairing rule —
 * ZoneSetupManager's own mapping), and dladm answers the live MAC.
 * @param {string} zoneName - Zone name
 * @param {number} index - The provisional entry's networks[] index
 * @returns {Promise<string|null>} The VNIC MAC or null
 */
const readProvisionalMac = async (zoneName, index) => {
  let liveConfig;
  try {
    liveConfig = await getZoneConfig(zoneName);
  } catch (error) {
    log.task.warn('Failed to read zone config for provisional MAC', {
      zone_name: zoneName,
      error: error.message,
    });
    return null;
  }
  const nets = Array.isArray(liveConfig?.net) ? liveConfig.net : [];
  const physical = nets[index]?.physical;
  if (!physical) {
    return null;
  }
  // dladm parseable output escapes the MAC's colons (aa\:bb\:…).
  const result = await executeCommand(`pfexec dladm show-vnic ${physical} -p -o macaddress`);
  if (!result.success || !result.output.trim()) {
    return null;
  }
  return result.output.trim().replace(/\\/gu, '');
};

/**
 * Resolve the provisioning transport from the DOCUMENT: an already-recorded
 * address answers immediately; otherwise read our dhcpd's lease for the
 * provisional VNIC's MAC and RECORD it into the document's provisional entry
 * (document honesty — the setDocumentDiskSize pattern). Null until the guest
 * has leased.
 * @param {string} zoneName - Zone name
 * @returns {Promise<string|null>} The transport IPv4 or null
 */
export const resolveProvisionalTransport = async zoneName => {
  const zone = await Zones.findOne({ where: { name: zoneName } });
  if (!zone) {
    return null;
  }
  const { networks } = parseConfiguration(zone);
  if (!Array.isArray(networks)) {
    return null;
  }
  const index = networks.findIndex(net => net?.provisional === true);
  if (index === -1) {
    return null;
  }
  if (networks[index].address) {
    return networks[index].address;
  }

  const mac = await readProvisionalMac(zoneName, index);
  if (!mac) {
    return null;
  }
  const leased = await readLeaseByMac(mac);
  if (!leased) {
    return null;
  }
  await setDocumentNetworkAddress(zoneName, index, leased);
  log.task.info('Provisioning lease recorded into the document', {
    zone_name: zoneName,
    address: leased,
    mac,
  });
  return leased;
};

/**
 * Poll for the provisioning lease until it appears or the deadline passes —
 * zone_wait_ssh's pre-step for chains built before the guest ever booted
 * (sequential recursion, the ssh poller's own pattern).
 * @param {string} zoneName - Zone name
 * @param {number} timeoutMs - Total wait budget
 * @param {number} intervalMs - Poll interval
 * @returns {Promise<string|null>} The transport IPv4 or null
 */
export const waitForProvisionalTransport = (zoneName, timeoutMs, intervalMs) => {
  const deadline = Date.now() + timeoutMs;
  const attempt = async () => {
    const ip = await resolveProvisionalTransport(zoneName);
    if (ip) {
      return ip;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise(resolve => {
      setTimeout(resolve, intervalMs);
    });
    return attempt();
  };
  return attempt();
};
