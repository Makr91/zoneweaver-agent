import { parseAsync } from '../../../lib/AsyncJson.js';
import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import Template from '../../../models/TemplateModel.js';
import { updateTaskProgress } from './utils/ProgressHelper.js';

/**
 * @fileoverview Template move task executor
 */

/**
 * Parse dependent clones from zfs get clones output
 * @param {string} clonesValue - Raw output from zfs get -H -o value clones
 * @returns {string[]} Array of clone dataset paths (empty if none)
 */
const parseDependentClones = clonesValue => {
  if (!clonesValue || clonesValue.trim() === '-' || clonesValue.trim() === '') {
    return [];
  }
  return clonesValue
    .trim()
    .split(',')
    .map(c => c.trim())
    .filter(Boolean);
};

/**
 * Execute a same-pool template move via ZFS rename
 * Instant operation — clones follow transparently
 * @param {Object} template - Template DB record
 * @param {string} sourcePath - Source ZFS dataset path
 * @param {string} targetPath - Target ZFS dataset path
 * @param {Object} task - Task record for progress updates
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeSamePoolMove = async (template, sourcePath, targetPath, task) => {
  await updateTaskProgress(task, 30, { status: 'renaming' });

  const renameResult = await executeCommand(`pfexec zfs rename -p ${sourcePath} ${targetPath}`);
  if (!renameResult.success) {
    return { success: false, error: `ZFS rename failed: ${renameResult.error}` };
  }

  await updateTaskProgress(task, 85, { status: 'verifying' });

  const verifyResult = await executeCommand(`pfexec zfs list -H -o name ${targetPath}`);
  if (!verifyResult.success) {
    return {
      success: false,
      error: `Rename verification failed: target dataset not found after rename`,
    };
  }

  await updateTaskProgress(task, 95, { status: 'updating_database' });
  await template.update({ dataset_path: targetPath });

  await updateTaskProgress(task, 100, { status: 'completed' });

  log.task.info('Template moved (same-pool rename)', {
    template_id: template.id,
    old_path: sourcePath,
    new_path: targetPath,
  });

  return {
    success: true,
    message: `Template moved from '${sourcePath}' to '${targetPath}' (same-pool rename)`,
  };
};

/**
 * Resolve clone dependencies for a cross-pool template move
 * Checks for dependent clones on @ready and optionally promotes one to free the template
 * @param {Object} template - Template DB record
 * @param {string} sourcePath - Source ZFS dataset path
 * @param {boolean} forcePromote - Whether to auto-promote a dependent clone
 * @param {Object} task - Task record for progress updates
 * @returns {Promise<{success: boolean, sendSource?: string, dependentClones?: string[], error?: string}>}
 */
const resolveCloneDependencies = async (template, sourcePath, forcePromote, task) => {
  await updateTaskProgress(task, 15, { status: 'checking_clones' });

  const snapCheck = await executeCommand(
    `pfexec zfs list -H -t snapshot -o name ${sourcePath}@ready`
  );
  if (!snapCheck.success) {
    return {
      success: false,
      error: `Source template missing @ready snapshot. Cannot perform cross-pool move.`,
    };
  }

  const clonesResult = await executeCommand(
    `pfexec zfs get -H -o value clones ${sourcePath}@ready`
  );
  const dependentClones = parseDependentClones(clonesResult.output);

  if (dependentClones.length === 0) {
    return { success: true, sendSource: `${sourcePath}@ready`, dependentClones };
  }

  if (!forcePromote) {
    log.task.warn('Template move blocked by dependent clones', {
      template_id: template.id,
      dependent_clones: dependentClones,
    });
    return {
      success: false,
      error: `Template has ${dependentClones.length} dependent ZFS clone(s). Set force_promote: true to auto-promote one clone and proceed.`,
      dependent_clones: dependentClones,
    };
  }

  const [cloneToPromote] = dependentClones;
  await updateTaskProgress(task, 20, {
    status: 'promoting_clone',
    clone: cloneToPromote,
    total_dependent_clones: dependentClones.length,
  });

  log.task.info('Promoting clone to free template for cross-pool move', {
    clone: cloneToPromote,
    template_path: sourcePath,
  });

  const promoteResult = await executeCommand(`pfexec zfs promote ${cloneToPromote}`);
  if (!promoteResult.success) {
    return {
      success: false,
      error: `Failed to promote clone '${cloneToPromote}': ${promoteResult.error}`,
    };
  }

  return { success: true, sendSource: `${cloneToPromote}@ready`, dependentClones };
};

/**
 * Execute a cross-pool template move via ZFS send/recv
 * Handles clone dependencies, transfers data, and cleans up the original
 * @param {Object} template - Template DB record
 * @param {string} sourcePath - Source ZFS dataset path
 * @param {string} targetPath - Target ZFS dataset path
 * @param {boolean} forcePromote - Whether to auto-promote dependent clones
 * @param {Object} task - Task record for progress updates
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeCrossPoolMove = async (template, sourcePath, targetPath, forcePromote, task) => {
  const cloneResult = await resolveCloneDependencies(template, sourcePath, forcePromote, task);
  if (!cloneResult.success) {
    return cloneResult;
  }

  const { sendSource, dependentClones } = cloneResult;

  // Create parent datasets on target pool
  await updateTaskProgress(task, 25, { status: 'creating_parents' });
  const targetParent = targetPath.substring(0, targetPath.lastIndexOf('/'));
  if (targetParent) {
    const createParentResult = await executeCommand(`pfexec zfs create -p ${targetParent}`);
    if (!createParentResult.success && !createParentResult.error?.includes('already exists')) {
      return {
        success: false,
        error: `Failed to create parent datasets: ${createParentResult.error}`,
      };
    }
  }

  // Send/recv to new pool
  await updateTaskProgress(task, 30, { status: 'transferring' });
  const sendRecvResult = await executeCommand(
    `pfexec zfs send -c ${sendSource} | pfexec zfs recv ${targetPath}`,
    3600 * 1000
  );
  if (!sendRecvResult.success) {
    return { success: false, error: `ZFS send/recv failed: ${sendRecvResult.error}` };
  }

  await updateTaskProgress(task, 80, { status: 'creating_snapshot' });

  // Ensure @ready snapshot exists on target
  const targetSnapCheck = await executeCommand(
    `pfexec zfs list -H -t snapshot -o name ${targetPath}@ready`
  );
  if (!targetSnapCheck.success) {
    const createSnapResult = await executeCommand(`pfexec zfs snapshot ${targetPath}@ready`);
    if (!createSnapResult.success) {
      log.task.warn('Failed to create @ready snapshot on target', {
        error: createSnapResult.error,
      });
    }
  }

  // Verify target dataset
  await updateTaskProgress(task, 85, { status: 'verifying' });
  const verifyResult = await executeCommand(`pfexec zfs list -H -o name ${targetPath}`);
  if (!verifyResult.success) {
    return {
      success: false,
      error: `Transfer verification failed: target dataset not found after send/recv`,
    };
  }

  // Destroy original template dataset
  await updateTaskProgress(task, 90, { status: 'destroying_original' });
  const destroyResult = await executeCommand(`pfexec zfs destroy -r ${sourcePath}`);
  if (!destroyResult.success) {
    log.task.warn('Failed to destroy original dataset after move (non-fatal)', {
      source_path: sourcePath,
      error: destroyResult.error,
    });
  }

  // Update database record
  await updateTaskProgress(task, 95, { status: 'updating_database' });
  await template.update({ dataset_path: targetPath });

  await updateTaskProgress(task, 100, {
    status: 'completed',
    promoted_clone: dependentClones.length > 0 ? dependentClones[0] : null,
    dependent_clones_repointed: dependentClones.length > 0 ? dependentClones.length - 1 : 0,
  });

  log.task.info('Template moved (cross-pool send/recv)', {
    template_id: template.id,
    old_path: sourcePath,
    new_path: targetPath,
    promoted_clone: dependentClones.length > 0 ? dependentClones[0] : null,
  });

  return {
    success: true,
    message: `Template moved from '${sourcePath}' to '${targetPath}' (cross-pool send/recv)`,
  };
};

/**
 * Execute template move task
 * Moves a template's ZFS dataset to a different pool/path and updates the DB record.
 * Same-pool: zfs rename (instant, clones follow transparently).
 * Cross-pool: zfs send/recv + destroy original. Blocks if dependent clones exist
 * unless force_promote is true (auto-promotes one clone to free the template).
 * @param {string} metadataJson - Task metadata as JSON string
 * @param {Object} task - The task row (progress updates write it directly)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeTemplateMoveTask = async (metadataJson, task) => {
  log.task.debug('Template move task starting');

  try {
    const metadata = await parseAsync(metadataJson);

    const { template_id, target_dataset_path, force_promote } = metadata;

    const template = await Template.findByPk(template_id);
    if (!template) {
      return { success: false, error: `Template not found: ${template_id}` };
    }

    const sourcePath = template.dataset_path;
    const targetPath = target_dataset_path;

    log.task.info('Template move task parameters', {
      template_id,
      source_path: sourcePath,
      target_path: targetPath,
      force_promote,
    });

    await updateTaskProgress(task, 5, { status: 'validating' });

    // Extract pool names (everything before first '/')
    const [sourcePool] = sourcePath.split('/');
    const [targetPool] = targetPath.split('/');

    // Verify target pool exists
    await updateTaskProgress(task, 10, { status: 'checking_target' });
    const poolCheck = await executeCommand(`pfexec zfs list -H -o name ${targetPool}`);
    if (!poolCheck.success) {
      return {
        success: false,
        error: `Target pool '${targetPool}' does not exist or is not accessible`,
      };
    }

    if (sourcePool === targetPool) {
      return executeSamePoolMove(template, sourcePath, targetPath, task);
    }

    return executeCrossPoolMove(template, sourcePath, targetPath, force_promote, task);
  } catch (error) {
    log.task.error('Template move task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Template move failed: ${error.message}` };
  }
};
