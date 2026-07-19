/**
 * @fileoverview Zone Network Modifier for Zone Configuration Changes
 * @description Handles adding and removing NICs from zone configurations via zonecfg
 */

import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import { syncZoneToDatabase, getZoneConfig } from '../../../lib/ZoneConfigUtils.js';
import Zones from '../../../models/ZoneModel.js';
import { updateTaskProgress } from '../../../lib/TaskProgressHelper.js';

/**
 * Render a nic entry's props map ({promiscphys: "on", …}) into zonecfg
 * `add property` sub-commands (net resource PROPERTIES — the bhyve brand
 * consumes netprop names like promiscphys/promiscrxonly/vqsize/mtu).
 * @param {Object} props - property name → value
 * @returns {string} zonecfg sub-commands ('' when empty)
 */
const buildPropCommands = props =>
  Object.entries(props || {})
    .map(([name, value]) => ` add property (name=${name},value=\\"${value}\\");`)
    .join('');

/**
 * Add NICs to zone configuration
 * @param {string} zoneName - Zone name
 * @param {Array} nics - Array of NIC configurations
 */
/**
 * Map NIC type to single-character code for VNIC naming
 * @param {string} nicType - NIC type string
 * @returns {string} Single character code
 */
const nicTypeCode = nicType => {
  const map = { external: 'e', internal: 'i', carp: 'c', management: 'm', host: 'h' };
  return map[nicType] || 'e';
};

/**
 * Map VM type to single-digit code for VNIC naming
 * @param {string} vmType - VM type string
 * @returns {string} Single digit code
 */
const vmTypeCode = vmType => {
  const map = { template: '1', development: '2', production: '3', firewall: '4', other: '5' };
  return map[vmType] || '3';
};

const addNics = async (zoneName, nics, zoneRecord, onData = null) => {
  const cmds = nics.map((nic, index) => {
    let { physical } = nic;
    if (!physical && zoneRecord?.server_id) {
      const typeChar = nicTypeCode(nic.nic_type);
      const vmChar = vmTypeCode(zoneRecord.vm_type);
      // Count existing NICs to offset the index
      const existingNicCount = zoneRecord.configuration?.net?.length || 0;
      const paddedServerId = zoneRecord.server_id.padStart(4, '0');
      physical = `vnic${typeChar}${vmChar}_${paddedServerId}_${existingNicCount + index}`;
    }
    if (!physical) {
      physical = `vnic_${zoneName}_${index}`;
    }
    let cmd = `add net; set physical=${physical};`;
    if (nic.global_nic) {
      cmd += ` set global-nic=${nic.global_nic};`;
    }
    if (nic.vlan_id) {
      cmd += ` set vlan-id=${nic.vlan_id};`;
    }
    if (nic.mac_addr) {
      cmd += ` set mac-addr=${nic.mac_addr};`;
    }
    if (nic.allowed_address) {
      cmd += ` set allowed-address=${nic.allowed_address};`;
    }
    // address/defrouter are SHARED-IP-only net properties — zonecfg refuses
    // them on this agent's ip-type=exclusive zones ("the address and default
    // router properties cannot be set", https://man.omnios.org/man8/zonecfg;
    // https://man.omnios.org/man7/zones). Left on the wire per Mark 2026-07-18.
    if (nic.address) {
      cmd += ` set address=${nic.address};`;
    }
    if (nic.defrouter) {
      cmd += ` set defrouter=${nic.defrouter};`;
    }
    cmd += buildPropCommands(nic.props);
    cmd += ` end;`;
    return cmd;
  });

  if (cmds.length > 0) {
    const nicResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${cmds.join(' ')}"`,
      undefined,
      onData
    );
    if (!nicResult.success) {
      throw new Error(`Failed to add NICs: ${nicResult.error}`);
    }
    log.task.info('Added NICs to zone', { zone_name: zoneName, count: nics.length });
  }
};

/**
 * Update existing NICs in place — select the net resource by physical and set
 * the provided properties. Provided keys SET; omitted keys keep their value.
 * Clearing a set-property is not part of this wire (detach + re-add covers
 * it). props entries REPLACE: the current value (from the live config's
 * netprop rendering) is removed first, then the new pair is added — zonecfg
 * properties have no in-place set.
 * @param {string} zoneName - Zone name
 * @param {Array} nics - Array of {physical, global_nic?, vlan_id?, mac_addr?,
 *   allowed_address?, address?, defrouter?, props?}
 */
const updateNics = async (zoneName, nics, onData = null) => {
  // Live config needed only when props replace existing values.
  const needsConfig = nics.some(nic => nic.props && Object.keys(nic.props).length > 0);
  const liveNets = needsConfig ? (await getZoneConfig(zoneName)).net || [] : [];
  const netByPhysical = new Map(liveNets.map(net => [net.physical, net]));

  const cmds = nics.map(nic => {
    if (!nic.physical) {
      throw new Error('update_nics entries need physical (the net resource selector)');
    }
    let cmd = `select net physical=${nic.physical};`;
    let sets = 0;
    // address/defrouter: SHARED-IP-only — refused by zonecfg on exclusive-IP
    // zones (https://man.omnios.org/man8/zonecfg). Left per Mark 2026-07-18.
    const setProps = [
      ['global-nic', nic.global_nic],
      ['vlan-id', nic.vlan_id],
      ['mac-addr', nic.mac_addr],
      ['allowed-address', nic.allowed_address],
      ['address', nic.address],
      ['defrouter', nic.defrouter],
    ];
    for (const [prop, value] of setProps) {
      if (value !== undefined) {
        cmd += ` set ${prop}=${value};`;
        sets++;
      }
    }
    if (nic.props && Object.keys(nic.props).length > 0) {
      const current = netByPhysical.get(nic.physical) || {};
      for (const [name, value] of Object.entries(nic.props)) {
        if (current[name] !== undefined) {
          cmd += ` remove property (name=${name},value=\\"${current[name]}\\");`;
        }
        cmd += ` add property (name=${name},value=\\"${value}\\");`;
        sets++;
      }
    }
    if (sets === 0) {
      throw new Error(`update_nics entry for ${nic.physical} sets no properties`);
    }
    cmd += ` end;`;
    return cmd;
  });

  if (cmds.length > 0) {
    const updateResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${cmds.join(' ')}"`,
      undefined,
      onData
    );
    if (!updateResult.success) {
      throw new Error(`Failed to update NICs: ${updateResult.error}`);
    }
    log.task.info('Updated NICs in zone', { zone_name: zoneName, count: nics.length });
  }
};

/**
 * Remove NICs from zone configuration
 * @param {string} zoneName - Zone name
 * @param {Array} nicNames - Array of NIC physical names to remove
 */
const removeNics = async (zoneName, nicNames, onData = null) => {
  const cmds = nicNames.map(nicName => `remove net physical=${nicName}`);

  if (cmds.length > 0) {
    const removeResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${cmds.join('; ')}"`,
      undefined,
      onData
    );
    if (!removeResult.success) {
      throw new Error(`Failed to remove NICs: ${removeResult.error}`);
    }
    log.task.info('Removed NICs from zone', { zone_name: zoneName, count: nicNames.length });
  }
};

/**
 * Handle network modifications
 * @param {string} zoneName - Zone name
 * @param {Object} metadata - Modification metadata
 * @param {Object} task - Task object
 * @param {Array} changes - Changes array
 */
export const handleNetworkModifications = async (
  zoneName,
  metadata,
  task,
  changes,
  onData = null
) => {
  if (metadata.add_nics?.length > 0) {
    await updateTaskProgress(task, 50, { status: 'adding_nics' });
    const zoneRecord = await Zones.findOne({ where: { name: zoneName } });
    await addNics(zoneName, metadata.add_nics, zoneRecord, onData);
    changes.push('add_nics');
    await syncZoneToDatabase(zoneName);
  }

  if (metadata.update_nics?.length > 0) {
    await updateTaskProgress(task, 52, { status: 'updating_nics' });
    await updateNics(zoneName, metadata.update_nics, onData);
    changes.push('update_nics');
    await syncZoneToDatabase(zoneName);
  }

  if (metadata.remove_nics?.length > 0) {
    await updateTaskProgress(task, 55, { status: 'removing_nics' });
    await removeNics(zoneName, metadata.remove_nics, onData);
    changes.push('remove_nics');
    await syncZoneToDatabase(zoneName);
  }
};
