import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

export const DHCPD_CONF_PATH = '/etc/dhcpd.conf';

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
export const executeCommand = async command => {
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
export const parseDhcpdConf = async () => {
  const result = await executeCommand(`cat ${DHCPD_CONF_PATH} 2>/dev/null`);
  const subnets = [];
  const hosts = [];
  const raw = result.success ? result.output : '';

  if (!result.success || !result.output) {
    return { subnets, hosts, raw };
  }

  const content = result.output;

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
