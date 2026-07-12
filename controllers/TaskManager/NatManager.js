/**
 * @fileoverview NAT and IP Forwarding Task Manager for Zoneweaver Agent
 * @description Executes NAT rule and IP forwarding tasks via ipnat/ipfilter and routeadm/ipadm
 */

import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import yj from 'yieldable-json';
import NatRules from '../../models/NatRuleModel.js';

/**
 * Refresh ipfilter service to apply NAT rule changes
 * @returns {Promise<{success: boolean, error?: string}>}
 */
const refreshIpfilter = async () => {
  // Refresh, then cycle the service to pick up changes
  const refreshResult = await executeCommand('pfexec svcadm refresh network/ipfilter');
  if (!refreshResult.success) {
    // Service might not be running yet, try enabling it
    const enableResult = await executeCommand('pfexec svcadm enable network/ipfilter');
    if (!enableResult.success) {
      return { success: false, error: enableResult.error };
    }
    return { success: true };
  }

  // Cycle the service to apply changes
  const disableResult = await executeCommand('pfexec svcadm disable network/ipfilter');
  if (!disableResult.success) {
    return { success: false, error: `Failed to disable ipfilter: ${disableResult.error}` };
  }

  const enableResult = await executeCommand('pfexec svcadm enable network/ipfilter');
  if (!enableResult.success) {
    return { success: false, error: `Failed to re-enable ipfilter: ${enableResult.error}` };
  }

  return { success: true };
};

/**
 * Parse a raw NAT rule string into components
 * @param {string} rule - Raw rule string
 * @returns {Object|null} Parsed rule object or null if invalid
 */
const parseNatRule = rule => {
  // Extract inline comment if present
  const commentMatch = rule.match(/#\s*(?<comment>.*)$/);
  const description = commentMatch ? commentMatch.groups.comment.trim() : null;
  const cleanRule = rule.replace(/#.*$/, '').trim();

  // Example: map igb0 10.0.0.0/24 -> 0/32 portmap tcp/udp auto
  // Example: rdr igb0 0.0.0.0/0 port 80 -> 10.0.0.5 port 80 tcp
  const parts = cleanRule.split(/\s+/);
  if (parts.length < 4) {
    return null;
  }

  const [type, bridge] = parts;

  // Basic parsing - this can be improved for complex rules
  // For now, we store the raw_rule as the unique identifier/content
  return {
    type,
    bridge,
    raw_rule: cleanRule,
    // Other fields are harder to extract reliably without a full parser,
    // but raw_rule is sufficient for sync
    subnet: parts[2], // Approximation
    target: parts[4], // Approximation
    protocol: cleanRule.includes('tcp/udp') ? 'tcp/udp' : 'any',
    description,
  };
};

/**
 * Synchronize Database with System Configuration File
 * 1. Read ipnat.conf
 * 2. Import new rules to DB
 * 3. Remove DB rules missing from file
 */
const syncDatabaseWithSystem = async () => {
  // 1. Read System Config
  const readResult = await executeCommand('cat /etc/ipf/ipnat.conf 2>/dev/null');
  const fileRules = new Set();

  if (readResult.success && readResult.output) {
    const lines = readResult.output.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        // Still ignore full-line comments
        fileRules.add(trimmed);
      }
    }
  }

  // 2. Get DB Rules
  const dbRules = await NatRules.findAll();

  // 3. Import missing rules (File -> DB)
  const importPromises = [];
  for (const ruleStr of fileRules) {
    // Parse first to get clean rule for comparison
    const parsed = parseNatRule(ruleStr);
    const exists = parsed ? dbRules.find(r => r.raw_rule === parsed.raw_rule) : null;

    if (!exists) {
      if (parsed) {
        importPromises.push(
          NatRules.create({
            ...parsed,
            created_by: 'system_import',
          }).then(() => {
            log.task.info('Imported manual NAT rule to database', { rule: ruleStr });
          })
        );
      }
    }
  }
  await Promise.all(importPromises);

  // 4. Prune deleted rules (DB -> File)
  const prunePromises = [];
  for (const dbRule of dbRules) {
    // Check if the clean raw_rule exists in the file (fileRules contains full lines with comments)
    const foundInFile = Array.from(fileRules).some(line => line.startsWith(dbRule.raw_rule));
    if (!foundInFile) {
      prunePromises.push(
        dbRule.destroy().then(() => {
          log.task.info('Removed deleted NAT rule from database', { rule: dbRule.raw_rule });
        })
      );
    }
  }
  await Promise.all(prunePromises);
};

/**
 * Execute NAT rule creation task
 * Appends a NAT rule to /etc/ipf/ipnat.conf and refreshes ipfilter
 * @param {string} metadataJson - JSON string with rule parameters
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeCreateNatRuleTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const {
      bridge,
      subnet,
      target = '0/32',
      protocol = 'tcp/udp',
      type = 'portmap',
      description,
      created_by,
    } = metadata;

    if (!bridge || !subnet) {
      return { success: false, error: 'bridge and subnet are required' };
    }

    // Build the NAT rule
    let rule;
    if (type === 'portmap') {
      rule = `map ${bridge} ${subnet} -> ${target} portmap ${protocol} auto`;
    } else if (type === 'bimap') {
      rule = `bimap ${bridge} ${subnet} -> ${target}`;
    } else if (type === 'rdr') {
      rule = `rdr ${bridge} ${subnet} -> ${target}`;
    } else {
      return { success: false, error: `Unsupported NAT type: ${type}` };
    }

    // Ensure /etc/ipf directory exists
    await executeCommand('pfexec mkdir -p /etc/ipf');

    // 1. Sync DB with current System State
    await syncDatabaseWithSystem();

    // 2. Check if rule already exists in DB (now synced)
    const existing = await NatRules.findOne({ where: { raw_rule: rule } });
    if (existing) {
      return {
        success: true,
        message: `NAT rule already exists: ${rule}`,
      };
    }

    // 3. Add to DB
    await NatRules.create({
      bridge,
      subnet,
      target,
      protocol,
      type,
      raw_rule: rule,
      created_by,
      description,
    });

    // 4. Regenerate File from DB
    const allRules = await NatRules.findAll();
    const configContent = allRules
      .map(r => (r.description ? `${r.raw_rule} # ${r.description}` : r.raw_rule))
      .join('\n');

    // Use heredoc pattern to correctly handle newlines
    const writeResult = await executeCommand(
      `pfexec bash -c 'cat > /etc/ipf/ipnat.conf << '"'"'IPNATEOF'"'"'\n${configContent}\nIPNATEOF'`
    );

    if (!writeResult.success) {
      return { success: false, error: `Failed to write NAT config: ${writeResult.error}` };
    }

    // Refresh ipfilter service
    const refreshResult = await refreshIpfilter();
    if (!refreshResult.success) {
      log.task.warn('NAT rule written but ipfilter refresh failed', {
        rule,
        error: refreshResult.error,
      });
      return {
        success: true,
        message: `NAT rule added but ipfilter refresh failed: ${refreshResult.error}`,
      };
    }

    log.task.info('NAT rule created successfully', { rule, bridge, subnet });
    return {
      success: true,
      message: `NAT rule created: ${rule}`,
    };
  } catch (error) {
    log.task.error('NAT rule creation failed', { error: error.message });
    return { success: false, error: `NAT rule creation failed: ${error.message}` };
  }
};

/**
 * Execute NAT rule deletion task
 * Removes a rule by line index from /etc/ipf/ipnat.conf and refreshes ipfilter
 * @param {string} metadataJson - JSON string with { rule_id }
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDeleteNatRuleTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { rule_id } = metadata; // This is now a UUID

    // 1. Sync DB with current System State
    await syncDatabaseWithSystem();

    // 2. Find Rule in DB
    const rule = await NatRules.findByPk(rule_id);
    if (!rule) {
      return { success: false, error: `NAT rule not found: ${rule_id}` };
    }

    const ruleText = rule.raw_rule;

    // 3. Delete from DB
    await rule.destroy();

    // 4. Regenerate File from DB
    const allRules = await NatRules.findAll();
    const configContent = allRules
      .map(r => (r.description ? `${r.raw_rule} # ${r.description}` : r.raw_rule))
      .join('\n');

    // Use heredoc pattern to correctly handle newlines
    const writeResult = await executeCommand(
      `pfexec bash -c 'cat > /etc/ipf/ipnat.conf << '"'"'IPNATEOF'"'"'\n${configContent}\nIPNATEOF'`
    );

    if (!writeResult.success) {
      return { success: false, error: `Failed to update NAT config: ${writeResult.error}` };
    }

    // Refresh ipfilter
    const refreshResult = await refreshIpfilter();
    if (!refreshResult.success) {
      log.task.warn('NAT rule removed but ipfilter refresh failed', { error: refreshResult.error });
    }

    log.task.info('NAT rule deleted successfully', { rule_id, rule: ruleText });
    return {
      success: true,
      message: `NAT rule deleted: ${ruleText}`,
    };
  } catch (error) {
    log.task.error('NAT rule deletion failed', { error: error.message });
    return { success: false, error: `NAT rule deletion failed: ${error.message}` };
  }
};

/**
 * Execute IP forwarding configuration task
 * Enables/disables global IPv4 forwarding and per-interface forwarding.
 * `global: false` limits the change to the named interfaces — the teardown
 * path uses it so removing the provisioning network never cuts off other
 * forwarding consumers on the host.
 * @param {string} metadataJson - JSON string with { enabled, interfaces, global }
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeConfigureForwardingTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { enabled, interfaces, global: touchGlobal = true } = metadata;
    const errors = [];

    // Configure global IPv4 forwarding
    if (enabled !== undefined && touchGlobal) {
      const action = enabled ? '-e' : '-d';
      const routeResult = await executeCommand(`pfexec routeadm -u ${action} ipv4-forwarding`);
      if (!routeResult.success) {
        errors.push(`Global forwarding: ${routeResult.error}`);
      }
    }

    // Configure per-interface forwarding
    if (interfaces && interfaces.length > 0) {
      const value = enabled !== false ? 'on' : 'off';
      const results = await Promise.all(
        interfaces.map(iface =>
          executeCommand(`pfexec ipadm set-ifprop -p forwarding=${value} -m ipv4 ${iface}`)
        )
      );
      results.forEach((res, idx) => {
        if (!res.success) {
          errors.push(`Interface ${interfaces[idx]}: ${res.error}`);
        }
      });
    }

    if (errors.length > 0) {
      log.task.warn('IP forwarding configuration had errors', { errors });
      return {
        success:
          errors.length <
          (interfaces || []).length + (enabled !== undefined && touchGlobal ? 1 : 0),
        message: `IP forwarding configured with ${errors.length} error(s)`,
        errors,
      };
    }

    log.task.info('IP forwarding configured successfully', { enabled, interfaces });
    return {
      success: true,
      message: 'IP forwarding configured successfully',
    };
  } catch (error) {
    log.task.error('IP forwarding configuration failed', { error: error.message });
    return { success: false, error: `IP forwarding configuration failed: ${error.message}` };
  }
};
