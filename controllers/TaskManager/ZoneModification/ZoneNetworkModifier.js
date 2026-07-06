/**
 * @fileoverview Zone Network Modifier for Zone Configuration Changes
 * @description Handles adding and removing NICs from zone configurations via zonecfg
 */

import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import { syncZoneToDatabase } from '../../../lib/ZoneConfigUtils.js';
import Zones from '../../../models/ZoneModel.js';
import { updateTaskProgress } from '../../../lib/TaskProgressHelper.js';

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

  if (metadata.remove_nics?.length > 0) {
    await updateTaskProgress(task, 55, { status: 'removing_nics' });
    await removeNics(zoneName, metadata.remove_nics, onData);
    changes.push('remove_nics');
    await syncZoneToDatabase(zoneName);
  }
};
