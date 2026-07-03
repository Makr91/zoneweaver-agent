/**
 * @fileoverview Zone Setup Task Manager for Zoneweaver Agent
 * @description Executes zlogin automation recipes against zones for early-boot configuration.
 *              Runs as a task in the TaskQueue system.
 */

import { log } from '../../lib/Logger.js';
import ZloginAutomation from '../../lib/ZloginAutomation.js';
import Recipes from '../../models/RecipeModel.js';
import Zones from '../../models/ZoneModel.js';
import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import NetworkCollector from '../../controllers/NetworkCollectorController/index.js';
import yj from 'yieldable-json';
import { getZoneConfig } from '../../lib/ZoneConfigUtils.js';

/**
 * Execute zone setup task (zlogin recipe execution)
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneSetupTask = async task => {
  const { zone_name } = task;
  let automation = null;

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(task.metadata, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { recipe_id, variables = {} } = metadata;

    if (!recipe_id) {
      return { success: false, error: 'recipe_id is required in task metadata' };
    }

    // Load recipe
    const recipe = await Recipes.findByPk(recipe_id);
    if (!recipe) {
      return { success: false, error: `Recipe '${recipe_id}' not found` };
    }

    // Fetch zone to get server_id and vm_type for vnic naming
    const zone = await Zones.findOne({ where: { name: zone_name } });
    if (!zone) {
      return { success: false, error: `Zone '${zone_name}' not found` };
    }

    // Get zone configuration to enumerate all NICs
    const zoneConfig = await getZoneConfig(zone_name);
    const nics = zoneConfig?.net || [];

    // NIC type and VM type mapping (vagrant-zones convention)
    const nicTypeMap = { external: 'e', internal: 'i', carp: 'c', management: 'm', host: 'h' };
    const vmTypeMap = {
      template: '1',
      development: '2',
      production: '3',
      firewall: '4',
      other: '5',
    };

    // Generate vnic_name for ALL NICs (deterministic from zone config)
    const nicData = nics.map((nic, index) => {
      // Determine nic_type from global-nic
      let nic_type = 'external'; // Default
      if (nic['global-nic']?.includes('estub')) {
        nic_type = 'internal';
      }

      const nicType = nicTypeMap[nic_type];
      const vmType = vmTypeMap[zone.vm_type] || '3';
      const serverId = zone.server_id.padStart(4, '0');
      const vnic_name = `vnic${nicType}${vmType}_${serverId}_${index}`;

      return {
        index,
        vnic_name,
        nic_type,
        global_nic: nic['global-nic'],
        vlan_id: nic['vlan-id'],
        physical: nic.physical,
      };
    });

    // Trigger network scan to populate NetworkInterfaces table with current VNICs and MACs
    const networkCollector = new NetworkCollector();
    await networkCollector.collectNetworkConfig();

    // Query database for ALL VNICs belonging to this zone
    const vnicRecords = await NetworkInterfaces.findAll({
      where: { zone: zone_name },
      order: [['scan_timestamp', 'DESC']],
    });

    // Match MACs from database to our nicData by vnic_name
    nicData.forEach(nic => {
      const vnicRecord = vnicRecords.find(v => v.link === nic.vnic_name);
      nic.mac = vnicRecord?.macaddress || null;
    });

    // Build indexed variables for all NICs (for recipe to use)
    nicData.forEach(nic => {
      const prefix = `nic_${nic.index}_`;
      variables[`${prefix}vnic_name`] = nic.vnic_name;

      // Normalize MAC address format (pad octets to 2 digits for netplan compatibility)
      if (nic.mac) {
        const normalizedMac = nic.mac
          .split(':')
          .map(octet => octet.padStart(2, '0'))
          .join(':');
        variables[`${prefix}mac`] = normalizedMac;
      } else {
        variables[`${prefix}mac`] = null;
      }

      variables[`${prefix}nic_type`] = nic.nic_type;
      variables[`${prefix}global_nic`] = nic.global_nic;
      if (nic.vlan_id) {
        variables[`${prefix}vlan_id`] = nic.vlan_id;
      }
    });

    // Merge network metadata (IP, gateway, DNS) from zone configuration
    let zoneConfigFromDB = zone.configuration;
    if (typeof zoneConfigFromDB === 'string') {
      try {
        zoneConfigFromDB = JSON.parse(zoneConfigFromDB);
      } catch (e) {
        log.task.warn('Failed to parse zone configuration from DB', { error: e.message });
        zoneConfigFromDB = {};
      }
    }

    // NEW STRUCTURE: Read from zone.configuration.networks (Hosts.yml structure)
    // OLD STRUCTURE: Read from zone.configuration.metadata.networks (legacy)
    const networksArray = zoneConfigFromDB?.networks || zoneConfigFromDB?.metadata?.networks;

    if (networksArray && Array.isArray(networksArray)) {
      networksArray.forEach((networkMeta, index) => {
        const prefix = `nic_${index}_`;
        if (networkMeta.address) {
          variables[`${prefix}ip`] = networkMeta.address;
        }
        if (networkMeta.netmask) {
          // Convert netmask to prefix (e.g., 255.255.255.0 → 24)
          const prefixBits =
            networkMeta.netmask
              .split('.')
              .map(octet => parseInt(octet).toString(2).padStart(8, '0'))
              .join('')
              .split('1').length - 1;
          variables[`${prefix}prefix`] = prefixBits.toString();
        }
        if (networkMeta.gateway) {
          variables[`${prefix}gateway`] = networkMeta.gateway;
        }
        if (networkMeta.dns) {
          variables[`${prefix}dns`] = Array.isArray(networkMeta.dns)
            ? networkMeta.dns.join(',')
            : networkMeta.dns;
        }
        if (networkMeta.provisional !== undefined) {
          variables[`${prefix}provisional`] = networkMeta.provisional;
        }
      });

      log.task.info('Merged network metadata from zone configuration', {
        zone_name,
        network_count: networksArray.length,
        source: zoneConfigFromDB?.networks ? 'networks' : 'metadata.networks',
      });
    }

    log.task.info('Auto-populated network variables for all NICs', {
      zone_name,
      nic_count: nicData.length,
      nics: nicData.map(n => ({ vnic_name: n.vnic_name, mac: n.mac })),
    });

    log.task.info('Starting zlogin automation', {
      zone_name,
      recipe_name: recipe.name,
      recipe_id,
    });

    // Create and execute automation
    automation = new ZloginAutomation(zone_name, {
      globalTimeout: (recipe.timeout_seconds || 300) * 1000,
    });

    const result = await automation.execute(recipe, variables);

    if (result.success) {
      log.task.info('Zlogin automation completed successfully', {
        zone_name,
        recipe_name: recipe.name,
        steps_executed: result.log?.length || 0,
      });
      return {
        success: true,
        message: `Zone setup completed using recipe '${recipe.name}'`,
        output: result.output,
      };
    }

    log.task.error('Zlogin automation failed', {
      zone_name,
      recipe_name: recipe.name,
      errors: result.errors,
    });
    return {
      success: false,
      error: `Zone setup failed: ${result.errors.join('; ')}`,
      output: result.output,
      log: result.log,
    };
  } catch (error) {
    log.task.error('Zone setup task failed', {
      zone_name,
      error: error.message,
    });
    return { success: false, error: `Zone setup failed: ${error.message}` };
  } finally {
    if (automation) {
      automation.destroy();
    }
  }
};
