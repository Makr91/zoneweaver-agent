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
import {
  isGuestAgentEnabled,
  guestSocketPath,
  runGuestCommand,
  guestExecAndWait,
  guestFileWrite,
} from '../../lib/QemuGuestAgent.js';

/**
 * Resolve {{variable}} placeholders in a recipe string; unresolved names
 * stay as-is (the dry-run preview's own behavior).
 * @param {string} str - Recipe string
 * @param {Object} vars - Variable map
 * @returns {string}
 */
const resolveRecipeVars = (str, vars) =>
  typeof str === 'string'
    ? str.replace(/\{\{(?<name>\w+)\}\}/gu, (match, ...args) => {
        const { name } = args[args.length - 1];
        return vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : match;
      })
    : str;

/**
 * Dotted netmask → prefix length ('255.255.255.0' → '24').
 * @param {string} netmask - Dotted netmask
 * @returns {string} Prefix bits
 */
const netmaskToPrefix = netmask =>
  String(
    netmask
      .split('.')
      .map(octet => parseInt(octet, 10).toString(2).padStart(8, '0'))
      .join('')
      .split('1').length - 1
  );

/**
 * Synthesize the guest's COMPLETE netplan document from the zone's declared
 * networks[]: one ethernets entry per NIC, MAC-matched and renamed to the
 * vnic name. A dhcp4 entry (or one with no address) leases; a static entry
 * carries addresses/routes/nameservers. The recipe writes it verbatim
 * ({{netplan_yaml}} → {{netplan_dest}}) — never to 50-cloud-init.yaml,
 * which the networking role's cleanup deletes.
 * @param {Array} nicData - Per-NIC data (index, vnic_name, mac)
 * @param {Array} networksArray - The document's networks[]
 * @returns {string} netplan YAML
 */
const buildNetplanYaml = (nicData, networksArray) => {
  const lines = ['network:', '  version: 2', '  ethernets:'];
  nicData.forEach(nic => {
    const meta = networksArray[nic.index] || {};
    lines.push(`    ${nic.vnic_name}:`);
    if (nic.mac) {
      const mac = nic.mac
        .split(':')
        .map(octet => octet.padStart(2, '0'))
        .join(':');
      lines.push('      match:', `        macaddress: "${mac}"`, `      set-name: ${nic.vnic_name}`);
    }
    if (meta.dhcp4 === true || !meta.address) {
      lines.push('      dhcp4: true');
      return;
    }
    const prefix = meta.netmask ? netmaskToPrefix(meta.netmask) : '24';
    lines.push(`      addresses: [${meta.address}/${prefix}]`);
    if (meta.gateway) {
      lines.push('      routes:', `        - to: ${meta.route || 'default'}`, `          via: ${meta.gateway}`);
    }
    const dns = Array.isArray(meta.dns)
      ? meta.dns.map(entry => entry?.nameserver).filter(Boolean)
      : [];
    if (dns.length > 0) {
      lines.push('      nameservers:', `        addresses: [${dns.join(', ')}]`);
    }
  });
  return `${lines.join('\n')}\n`;
};

/**
 * Run ONE recipe step over the guest-agent channel: command → guest-exec
 * through the OS shell; template → guest-file-write; delay honored;
 * wait/send are console choreography with no qga meaning — narrated as
 * skipped.
 * @param {string} socketPath - qga socket
 * @param {Object} recipe - Recipe record (os_family selects the shell)
 * @param {Object} step - Recipe step
 * @param {number} index - Step index (narration)
 * @param {Object} variables - Resolved variable map
 * @param {string[]} outputs - Narration sink
 * @returns {Promise<void>}
 */
const runQgaStep = async (socketPath, recipe, step, index, variables, outputs) => {
  if (step.type === 'wait' || step.type === 'send') {
    outputs.push(`[qga] step ${index} (${step.type}) skipped — console choreography`);
    return;
  }
  if (step.type === 'delay') {
    await new Promise(resolve => {
      setTimeout(resolve, (step.seconds || 1) * 1000);
    });
    return;
  }
  if (step.type === 'template') {
    const dest = resolveRecipeVars(step.dest, variables);
    await guestFileWrite(socketPath, dest, resolveRecipeVars(step.content, variables));
    outputs.push(`[qga] wrote ${dest}`);
    return;
  }
  const commandLine = resolveRecipeVars(step.value, variables);
  const shell = recipe.os_family === 'windows' ? ['cmd.exe', '/c'] : ['/bin/sh', '-c'];
  const result = await guestExecAndWait(socketPath, shell[0], [shell[1], commandLine]);
  outputs.push(`[qga] ${commandLine} → exit ${result.exitcode}\n${result.stdout}${result.stderr}`);
  if (step.check_exit_code !== false && result.exitcode !== 0) {
    throw new Error(
      `step ${index} (${commandLine}) exited ${result.exitcode}: ${result.stderr || result.stdout}`
    );
  }
};

/**
 * The setup ladder's qga rung: when the channel is configured AND the guest
 * agent answers, the recipe executes over qga — structured guest-exec and
 * file writes, no networking and no console choreography needed. Null when
 * the channel is absent, silent, or the run fails (the caller falls back to
 * the zlogin console).
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfigFromDB - Stored zone configuration (zonepath)
 * @param {Object} recipe - Recipe record
 * @param {Object} variables - Resolved variable map
 * @returns {Promise<Object|null>} Task result or null to fall back
 */
const tryQgaSetup = async (zoneName, zoneConfigFromDB, recipe, variables) => {
  if (!isGuestAgentEnabled() || !zoneConfigFromDB?.zonepath) {
    return null;
  }
  const socketPath = guestSocketPath(zoneConfigFromDB.zonepath);
  try {
    await runGuestCommand(socketPath, 'guest-ping', null, 3000);
  } catch {
    return null;
  }
  log.task.info('Running setup recipe over the guest-agent channel', {
    zone_name: zoneName,
    recipe_name: recipe.name,
  });
  const outputs = [];
  try {
    await recipe.steps.reduce(
      (chain, step, index) =>
        chain.then(() => runQgaStep(socketPath, recipe, step, index, variables, outputs)),
      Promise.resolve()
    );
    return {
      success: true,
      message: `Zone setup completed using recipe '${recipe.name}' over the guest-agent channel`,
      output: outputs.join('\n'),
    };
  } catch (error) {
    log.task.warn('Guest-agent setup failed — falling back to the zlogin console', {
      zone_name: zoneName,
      error: error.message,
    });
    return null;
  }
};

/**
 * Execute zone setup task — the transport ladder: SSH answering skipped the
 * task at chain build; a responding guest agent runs the recipe over qga;
 * the zlogin console is the always-available last resort.
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

    // The document's networks[] pairs with the net resources BY INDEX (the
    // declared pairing rule) — the CLASS is its declared `type` key, exactly
    // as Hosts.rb derived it (nictype: network['type']); never inferred from
    // link names.
    let zoneConfigFromDB = zone.configuration;
    if (typeof zoneConfigFromDB === 'string') {
      try {
        zoneConfigFromDB = JSON.parse(zoneConfigFromDB);
      } catch (e) {
        log.task.warn('Failed to parse zone configuration from DB', { error: e.message });
        zoneConfigFromDB = {};
      }
    }
    const networksArray = Array.isArray(zoneConfigFromDB?.networks)
      ? zoneConfigFromDB.networks
      : [];

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
      const nic_type = networksArray[index]?.type === 'internal' ? 'internal' : 'external';
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

    // Merge network metadata (IP, gateway, DNS, route) from the document —
    // dns is the document contract's MAP shape [{nameserver: ip}]; route
    // rides VERBATIM to the guest config (guest-owns-routes ruling), with
    // the contract's own "default" when the entry carries none.
    if (networksArray.length > 0) {
      networksArray.forEach((networkMeta, index) => {
        const prefix = `nic_${index}_`;
        if (networkMeta.address) {
          variables[`${prefix}ip`] = networkMeta.address;
        }
        if (networkMeta.netmask) {
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
        if (Array.isArray(networkMeta.dns)) {
          variables[`${prefix}dns`] = networkMeta.dns
            .map(entry => entry?.nameserver)
            .filter(Boolean)
            .join(',');
        }
        variables[`${prefix}route`] = networkMeta.route || 'default';
        if (networkMeta.provisional !== undefined) {
          variables[`${prefix}provisional`] = networkMeta.provisional;
        }
      });

      log.task.info('Merged network metadata from zone configuration', {
        zone_name,
        network_count: networksArray.length,
      });
    }

    variables.netplan_dest = variables.netplan_dest || '/etc/netplan/60-zoneweaver.yaml';
    variables.netplan_yaml = buildNetplanYaml(nicData, networksArray);

    log.task.info('Auto-populated network variables for all NICs', {
      zone_name,
      nic_count: nicData.length,
      nics: nicData.map(n => ({ vnic_name: n.vnic_name, mac: n.mac })),
    });

    const qgaResult = await tryQgaSetup(zone_name, zoneConfigFromDB, recipe, variables);
    if (qgaResult) {
      return qgaResult;
    }

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
