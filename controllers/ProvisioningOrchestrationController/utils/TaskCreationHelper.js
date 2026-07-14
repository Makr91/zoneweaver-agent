/**
 * @fileoverview Task creation helpers for provisioning orchestration
 */

import Tasks from '../../../models/TaskModel.js';
import { waitForSSH } from '../../../lib/SSHManager.js';
import { log } from '../../../lib/Logger.js';

/**
 * Create a task in the chain. `parent: true` creates a pure anchor — born
 * running with started_at stamped, never dispatched (the queue picks only
 * pending rows); the child rollup drives its state (the Go queue's model).
 * @param {Object} params - Task parameters
 * @returns {Promise<Object>} Created task
 */
export const createTask = params =>
  Tasks.create({
    zone_name: params.zone_name,
    operation: params.operation,
    status: params.parent ? 'running' : 'pending',
    started_at: params.parent ? new Date() : null,
    metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    depends_on: params.depends_on,
    parent_task_id: params.parent_task_id,
    created_by: params.created_by,
  });

/**
 * Create sequential folder sync tasks. The FIRST child depends on the outer
 * chain's previous task (never on its own parent — the parent is a running
 * anchor whose completion the children themselves drive, so a child gating
 * on it would deadlock the chain).
 * @param {Array} folders - Folders to sync
 * @param {string} zoneName - Zone name
 * @param {string} zoneIP - Zone IP address
 * @param {Object} credentials - SSH credentials
 * @param {Object} provisioning - Provisioning config
 * @param {string} syncParentTaskId - Parent anchor task ID
 * @param {string|null} firstDependsOn - Outer-chain dependency for the first child
 * @param {string} createdBy - Task creator
 * @returns {Promise<string|null>} The LAST sync child's task id (firstDependsOn when no folders)
 */
export const createSequentialFolderTasks = (
  folders,
  zoneName,
  zoneIP,
  credentials,
  provisioning,
  syncParentTaskId,
  firstDependsOn,
  createdBy
) =>
  folders.reduce(
    (promise, folder) =>
      promise.then(prevTaskId =>
        createTask({
          zone_name: zoneName,
          operation: 'zone_sync',
          metadata: {
            ip: zoneIP,
            port: provisioning.ssh_port || 22,
            credentials,
            folder,
          },
          depends_on: prevTaskId,
          parent_task_id: syncParentTaskId,
          created_by: createdBy,
        }).then(task => task.id)
      ),
    Promise.resolve(firstDependsOn)
  );

/**
 * Create sequential playbook provision tasks. Same first-child dependency
 * rule as the sync chain: children never gate on their own parent anchor.
 * @param {Array} playbooks - Playbooks to execute
 * @param {string} zoneName - Zone name
 * @param {string} zoneIP - Zone IP address
 * @param {Object} credentials - SSH credentials
 * @param {Object} provisioning - Provisioning config
 * @param {string} provisionParentTaskId - Parent anchor task ID
 * @param {string|null} firstDependsOn - Outer-chain dependency for the first child
 * @param {string} createdBy - Task creator
 * @returns {Promise<string|null>} The LAST provision child's task id
 */
export const createSequentialPlaybookTasks = (
  playbooks,
  zoneName,
  zoneIP,
  credentials,
  provisioning,
  provisionParentTaskId,
  firstDependsOn,
  createdBy
) =>
  playbooks.reduce(
    (promise, playbook, index) =>
      promise.then(prevTaskId =>
        createTask({
          zone_name: zoneName,
          operation: 'zone_provision',
          metadata: {
            ip: zoneIP,
            port: provisioning.ssh_port || 22,
            credentials,
            playbook,
            // The run's LAST playbook carries the provisioner_state stamp
            // (Hosts.rb results.yml semantics; `final` is the shared wire key
            // with the Go agent's provision metadata).
            final: index === playbooks.length - 1,
          },
          depends_on: prevTaskId,
          parent_task_id: provisionParentTaskId,
          created_by: createdBy,
        }).then(task => task.id)
      ),
    Promise.resolve(firstDependsOn)
  );

/**
 * Create sequential shell-script tasks (one zone_shell per script, list order
 * — Hosts.rb runs provisioning.shell.scripts in order, after the sync phase
 * and before the provision phase). Same first-child dependency rule as the
 * sync chain: children never gate on their own parent anchor.
 * @param {Array<string>} scripts - Package-relative script paths
 * @param {string} zoneName - Zone name
 * @param {string} zoneIP - Zone IP address
 * @param {Object} credentials - SSH credentials
 * @param {Object} provisioning - Provisioning config
 * @param {string} shellParentTaskId - Parent anchor task ID
 * @param {string|null} firstDependsOn - Outer-chain dependency for the first child
 * @param {string} createdBy - Task creator
 * @returns {Promise<string|null>} The LAST shell child's task id
 */
export const createSequentialShellTasks = (
  scripts,
  zoneName,
  zoneIP,
  credentials,
  provisioning,
  shellParentTaskId,
  firstDependsOn,
  createdBy
) =>
  scripts.reduce(
    (promise, script) =>
      promise.then(prevTaskId =>
        createTask({
          zone_name: zoneName,
          operation: 'zone_shell',
          metadata: {
            ip: zoneIP,
            port: provisioning.ssh_port || 22,
            credentials,
            script,
          },
          depends_on: prevTaskId,
          parent_task_id: shellParentTaskId,
          created_by: createdBy,
        }).then(task => task.id)
      ),
    Promise.resolve(firstDependsOn)
  );

/**
 * Folders eligible for syncback (shared semantics with the Go agent):
 * syncback: true, not disabled, and not the virtualbox pseudo-transport.
 * @param {Array} folders - Folders from the provisioning document
 * @returns {Array} Flagged folders
 */
export const syncbackEligibleFolders = folders =>
  folders.filter(
    folder =>
      folder.syncback === true &&
      !folder.disabled &&
      (folder.type || '').toLowerCase() !== 'virtualbox'
  );

/**
 * Create sequential syncback tasks (one zone_syncback per flagged folder).
 * Same first-child dependency rule as the sync chain.
 * @param {Array} folders - Flagged folders to pull back
 * @param {string} zoneName - Zone name
 * @param {string} zoneIP - Zone IP address
 * @param {Object} credentials - SSH credentials
 * @param {Object} provisioning - Provisioning config
 * @param {string} syncbackParentTaskId - Parent anchor task ID
 * @param {string|null} firstDependsOn - Outer-chain dependency for the first child
 * @param {string} createdBy - Task creator
 * @returns {Promise<string|null>} The LAST syncback child's task id
 */
export const createSequentialSyncbackTasks = (
  folders,
  zoneName,
  zoneIP,
  credentials,
  provisioning,
  syncbackParentTaskId,
  firstDependsOn,
  createdBy
) =>
  folders.reduce(
    (promise, folder) =>
      promise.then(prevTaskId =>
        createTask({
          zone_name: zoneName,
          operation: 'zone_syncback',
          metadata: {
            ip: zoneIP,
            port: provisioning.ssh_port || 22,
            credentials,
            folder,
          },
          depends_on: prevTaskId,
          parent_task_id: syncbackParentTaskId,
          created_by: createdBy,
        }).then(task => task.id)
      ),
    Promise.resolve(firstDependsOn)
  );

/**
 * Whether a zone has completed at least one successful provision.
 * Read from configuration.provisioner_state, stamped by the zone_provision
 * executor — the results.yml role in Hosts.rb's run-directive handling.
 * @param {Object} zone - Zone database record
 * @returns {boolean} True when a prior provision succeeded
 */
export const hasZoneProvisionedBefore = zone => {
  let zoneConfig = zone?.configuration;
  if (typeof zoneConfig === 'string') {
    try {
      zoneConfig = JSON.parse(zoneConfig);
    } catch {
      return false;
    }
  }
  return Boolean(zoneConfig?.provisioner_state?.last_provisioned_at);
};

/**
 * Filter playbooks by their run directive (Hosts.rb semantics: always = every
 * provision; not_first = only after a prior successful provision; once and
 * anything unrecognized = only when never provisioned).
 * @param {Array} playbooks - Playbook configuration objects
 * @param {boolean} hasProvisionedBefore - Whether a provision already succeeded
 * @returns {{included: Array, skipped: Array<{playbook: string, run: string}>}}
 */
export const filterPlaybooksByRun = (playbooks, hasProvisionedBefore) => {
  const included = [];
  const skipped = [];

  playbooks.forEach(playbook => {
    const run = playbook.run || 'once';
    let shouldRun;
    if (run === 'always') {
      shouldRun = true;
    } else if (run === 'not_first') {
      shouldRun = hasProvisionedBefore;
    } else {
      shouldRun = !hasProvisionedBefore;
    }

    if (shouldRun) {
      included.push(playbook);
    } else {
      skipped.push({ playbook: playbook.playbook, run });
    }
  });

  return { included, skipped };
};

/**
 * Check if SSH is accessible and zone_setup can be skipped
 * @param {Object} zone - Zone database record
 * @param {string} zoneIP - Zone IP address
 * @param {Object} provisioning - Provisioning config
 * @returns {Promise<boolean>} True if should skip zone_setup
 */
export const shouldSkipZoneSetup = async (zone, zoneIP, provisioning) => {
  if (zone.status !== 'running') {
    return false;
  }

  try {
    const zoneConfig =
      typeof zone.configuration === 'string' ? JSON.parse(zone.configuration) : zone.configuration;
    const provisioningBasePath = zoneConfig.zonepath
      ? `${zoneConfig.zonepath.replace('/path', '')}/provisioning`
      : null;

    const sshCheck = await waitForSSH(
      zoneIP,
      provisioning.credentials?.username || 'root',
      provisioning.credentials,
      provisioning.ssh_port || 22,
      5000,
      2000,
      provisioningBasePath
    );

    if (sshCheck.success) {
      log.api.info('SSH already accessible, skipping zone_setup', {
        zone_name: zone.name,
        ip: zoneIP,
      });
      return true;
    }
  } catch (error) {
    log.api.debug('SSH check failed, will run zone_setup', {
      zone_name: zone.name,
      error: error.message,
    });
  }

  return false;
};
