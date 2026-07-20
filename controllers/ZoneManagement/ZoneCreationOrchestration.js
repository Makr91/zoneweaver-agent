import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { createZoneCreationSubTasks } from './ZoneCreationHelpers.js';

/**
 * Queue the single-host create orchestration — the parent anchor + sub-task
 * chain — and shape the wire response. The orchestration parent is a pure
 * anchor: born running, never dispatched (the queue picks only pending
 * rows); the child rollup drives its state (the Go queue's model).
 * @param {string} finalZoneName - Resolved zone name
 * @param {Object} body - Post-render create body
 * @param {Object|null} networkSetup - The ensure hook's queued chain (null when ready)
 * @param {boolean} startAfterCreate - Whether to chain a start task
 * @param {string} createdBy - Task creator
 * @param {Array} allWarnings - Resource + disk warnings
 * @returns {Promise<Object>} The create response body
 */
export const queueCreateOrchestration = async (
  finalZoneName,
  body,
  networkSetup,
  startAfterCreate,
  createdBy,
  allWarnings
) => {
  const parentTask = await Tasks.create({
    zone_name: finalZoneName,
    operation: 'zone_create_orchestration',
    priority: TaskPriority.MEDIUM,
    created_by: createdBy,
    metadata: JSON.stringify(body),
    status: 'running',
    started_at: new Date(),
  });

  const { subTasks } = await createZoneCreationSubTasks(
    finalZoneName,
    body,
    parentTask.id,
    networkSetup?.lastTaskId ?? null,
    startAfterCreate,
    createdBy
  );
  if (networkSetup) {
    subTasks.network_setup = networkSetup.parentTaskId;
  }

  const createResponse = {
    success: true,
    parent_task_id: parentTask.id,
    machine_name: finalZoneName,
    operation: 'zone_create_orchestration',
    status: 'pending',
    message: 'Zone creation queued',
    requires_download: false,
    sub_tasks: subTasks,
  };
  if (allWarnings.length > 0) {
    createResponse.resource_warnings = allWarnings;
  }
  return createResponse;
};
