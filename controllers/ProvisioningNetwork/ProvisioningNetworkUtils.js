import { exec } from 'child_process';
import util from 'util';
import { getProvisioningNetworkConfig } from '../../lib/ProvisioningNetwork.js';

const execPromise = util.promisify(exec);

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

export const getProvNetConfig = getProvisioningNetworkConfig;

/**
 * Check if a component exists
 */
export const componentExists = async (type, name) => {
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
 * Check every provisioning-network component's presence — THE one readiness
 * read (the status endpoint and the packaged-create ensure hook share it).
 * @param {Object} netConfig - Effective provisioning network config
 * @returns {Promise<Object>} Per-component flags + overall ready
 */
export const checkProvisioningNetworkReady = async netConfig => {
  const etherstubExists = await componentExists('etherstub', netConfig.etherstub_name);
  const vnicExists = await componentExists('vnic', netConfig.host_vnic_name);
  const ipExists = await componentExists('ip', `${netConfig.host_vnic_name}/v4static`);

  const natResult = await executeCommand('cat /etc/ipf/ipnat.conf 2>/dev/null');
  const [subnetBase] = netConfig.subnet.split('/');
  const natConfigured = natResult.success && natResult.output.includes(subnetBase);

  const fwdResult = await executeCommand('pfexec routeadm -p 2>/dev/null');
  const forwardingEnabled =
    fwdResult.success &&
    fwdResult.output.includes('ipv4-forwarding') &&
    fwdResult.output.includes('current=enabled');

  const dhcpResult = await executeCommand('svcs -H -o state network/service/dhcp:ipv4 2>/dev/null');
  const dhcpRunning = dhcpResult.success && dhcpResult.output.trim() === 'online';

  return {
    etherstubExists,
    vnicExists,
    ipExists,
    natConfigured,
    forwardingEnabled,
    dhcpRunning,
    ready:
      etherstubExists &&
      vnicExists &&
      ipExists &&
      natConfigured &&
      forwardingEnabled &&
      dhcpRunning,
  };
};

/**
 * Detect the active external interface for NAT bridge
 * @returns {Promise<string|null>}
 */
export const detectActiveInterface = async () => {
  const routeResult = await executeCommand('pfexec route -n get default 2>/dev/null');
  if (routeResult.success) {
    const ifMatch = routeResult.output.match(/interface:\s*(?<iface>\S+)/);
    if (ifMatch) {
      return ifMatch.groups.iface;
    }
  }

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
