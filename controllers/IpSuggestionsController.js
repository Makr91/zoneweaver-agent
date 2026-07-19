/**
 * @fileoverview Free-IP suggestions for static-address pickers
 * @description The converged cross-agent "IP checker" wire (sync 2026-07-17,
 * frozen; Go shipped the same shape): the host's default-route interface
 * names the subnet, the ARP table + the machine documents' address pins +
 * the host's own addresses mark what's taken, and the first N unused host
 * addresses are offered. ADVISORY only — a suggestion is point-in-time,
 * never a reservation; pickers keep a free-text escape. IPv4 only.
 */

import { executeCommand } from '../lib/CommandManager.js';
import { parseConfiguration } from '../lib/ZoneConfigUtils.js';
import Zones from '../models/ZoneModel.js';
import { log } from '../lib/Logger.js';

const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/u;

const ipToInt = ip =>
  ip.split('.').reduce((acc, octet) => acc * 256 + (Number(octet) & 255), 0) >>> 0;

const intToIp = value =>
  [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');

const prefixToMask = prefix => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

/**
 * The default route's interface + gateway (route -n get default — the
 * provisioning-network controller's own parse).
 * @returns {Promise<{iface: string|null, gateway: string|null}>}
 */
const readDefaultRoute = async () => {
  const result = await executeCommand('pfexec route -n get default');
  if (!result.success) {
    return { iface: null, gateway: null };
  }
  const iface = result.output.match(/interface:\s*(?<iface>\S+)/u)?.groups.iface || null;
  const gatewayMatch = result.output.match(/gateway:\s*(?<gateway>\S+)/u)?.groups.gateway || null;
  const gateway = gatewayMatch && IPV4_PATTERN.test(gatewayMatch) ? gatewayMatch : null;
  return { iface, gateway };
};

/**
 * The interface's first IPv4 CIDR + every host-owned IPv4 (one ipadm read).
 * @param {string} iface - Default-route interface
 * @returns {Promise<{cidr: string|null, hostAddresses: string[]}>}
 */
const readHostAddresses = async iface => {
  const result = await executeCommand('pfexec ipadm show-addr -p -o addrobj,addr');
  if (!result.success) {
    return { cidr: null, hostAddresses: [] };
  }
  let cidr = null;
  const hostAddresses = [];
  for (const line of result.output.split('\n')) {
    const [addrobj, addr] = line.split(':');
    const match = addr?.match(/^(?<ip>(?:\d{1,3}\.){3}\d{1,3})\/(?<prefix>\d{1,2})$/u);
    if (!match) {
      continue;
    }
    hostAddresses.push(match.groups.ip);
    if (!cidr && addrobj?.startsWith(`${iface}/`)) {
      cidr = addr.trim();
    }
  }
  return { cidr, hostAddresses };
};

/** Every IPv4 the ARP table knows (live neighbors on the wire). */
const readArpNeighbors = async () => {
  const result = await executeCommand('pfexec arp -an');
  if (!result.success) {
    return [];
  }
  const neighbors = [];
  for (const line of result.output.split('\n')) {
    const match = line.match(IPV4_PATTERN);
    if (match) {
      neighbors.push(match[0]);
    }
  }
  return neighbors;
};

/**
 * Every address any machine document pins (powered-off machines' statics
 * never show in ARP but ARE taken — the converged rule).
 */
const readDocumentAddressPins = async () => {
  const pins = [];
  const zones = await Zones.findAll();
  for (const zone of zones) {
    const { networks } = parseConfiguration(zone);
    if (Array.isArray(networks)) {
      for (const net of networks) {
        if (net?.address && IPV4_PATTERN.test(String(net.address))) {
          pins.push(String(net.address));
        }
      }
    }
  }
  return pins;
};

/**
 * @swagger
 * /network/ip-suggestions:
 *   get:
 *     summary: Suggest free IPs on the host's default-route subnet
 *     description: |
 *       The converged cross-agent static-IP picker feed (same wire as the Go
 *       agent): the default-route interface names the subnet; used = ARP
 *       neighbors ∪ machine documents' networks[].address pins (powered-off
 *       statics ARE taken) ∪ the gateway ∪ the host's own addresses,
 *       subnet-scoped; suggestions = the first N unused host addresses,
 *       ascending. ADVISORY and point-in-time — never a reservation; keep a
 *       free-text escape in pickers. IPv4 only.
 *     tags: [Networking]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: count
 *         schema:
 *           type: integer
 *           default: 10
 *           maximum: 256
 *         description: How many suggestions to return (cap 256)
 *     responses:
 *       200:
 *         description: Suggestions document
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 interface: { type: string }
 *                 subnet: { type: string, example: "10.12.0.0/24" }
 *                 gateway: { type: string, nullable: true }
 *                 used:
 *                   type: array
 *                   items: { type: string }
 *                 suggestions:
 *                   type: array
 *                   items: { type: string }
 *                 total_used: { type: integer }
 *       500:
 *         description: No default route / enumeration failure — {error, details?}
 */
export const getIpSuggestions = async (req, res) => {
  try {
    const count = Math.min(Math.max(Number(req.query.count) || 10, 1), 256);

    const { iface, gateway } = await readDefaultRoute();
    if (!iface) {
      return res.status(500).json({ error: 'No default route found on this host' });
    }
    const { cidr, hostAddresses } = await readHostAddresses(iface);
    if (!cidr) {
      return res.status(500).json({
        error: `Default-route interface ${iface} carries no IPv4 address`,
      });
    }

    const [ipPart, prefixPart] = cidr.split('/');
    const prefix = Number(prefixPart);
    const mask = prefixToMask(prefix);
    const network = (ipToInt(ipPart) & mask) >>> 0;
    const broadcast = (network | (~mask >>> 0)) >>> 0;
    const inSubnet = ip => (ipToInt(ip) & mask) >>> 0 === network;

    const [neighbors, pins] = await Promise.all([readArpNeighbors(), readDocumentAddressPins()]);
    const used = new Set(
      [...neighbors, ...pins, ...(gateway ? [gateway] : []), ...hostAddresses].filter(inSubnet)
    );

    const suggestions = [];
    for (let candidate = network + 1; candidate < broadcast; candidate++) {
      const ip = intToIp(candidate);
      if (!used.has(ip)) {
        suggestions.push(ip);
        if (suggestions.length >= count) {
          break;
        }
      }
    }

    return res.json({
      interface: iface,
      subnet: `${intToIp(network)}/${prefix}`,
      gateway,
      used: [...used].sort((a, b) => ipToInt(a) - ipToInt(b)),
      suggestions,
      total_used: used.size,
    });
  } catch (error) {
    log.api.error('IP suggestions failed', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Failed to build IP suggestions', details: error.message });
  }
};
