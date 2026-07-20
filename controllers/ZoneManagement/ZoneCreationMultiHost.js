import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import {
  validateZoneName,
  consoleportRangeError,
  vcpusCountError,
} from '../../lib/ZoneValidation.js';
import { validateZoneCreationResources } from '../../lib/ResourceValidation.js';
import { ensureProvisioningNetwork } from '../ProvisioningNetworkController.js';
import {
  resolveBoxToTemplate,
  resolveZoneName,
  createZoneCreationSubTasks,
} from './ZoneCreationHelpers.js';
import {
  prepareAndValidateDisks,
  enrichBootTemplate,
  bootStrategyProblem,
  firmwareConflictWarning,
} from './ZoneCreationValidation.js';
import { findExistingZoneConflict } from './ZoneCreationController.js';

/**
 * Validate + name-resolve ONE host of a multi-host create. Refusals return
 * {problem}; success returns the prepared entry.
 * @param {Object} hostBody - Per-machine create body
 * @param {number} index - Position in hosts[] (for error naming)
 * @returns {Promise<Object>} {problem} | {finalZoneName, hostBody, warnings}
 */
const prepareMultiHostEntry = async (hostBody, index) => {
  const label = `multi-host entry ${index + 1}`;
  const { settings, zones } = hostBody;
  if (!settings?.hostname || !settings?.domain || !zones?.brand) {
    return {
      problem: {
        status: 400,
        payload: {
          error: `${label}: settings.hostname, settings.domain, and zones.brand are required`,
        },
      },
    };
  }
  const baseName = `${settings.hostname}.${settings.domain}`;
  if (!validateZoneName(baseName)) {
    return {
      problem: { status: 400, payload: { error: `${label}: invalid zone name ${baseName}` } },
    };
  }
  const preflightProblem =
    consoleportRangeError(settings.consoleport) || vcpusCountError(settings.vcpus);
  if (preflightProblem) {
    return {
      problem: { status: 400, payload: { error: `${label}: ${preflightProblem}` } },
    };
  }
  const diskPrep = await prepareAndValidateDisks(hostBody);
  if (diskPrep.error) {
    return {
      problem: { status: 400, payload: { error: `${label}: ${diskPrep.error}` } },
    };
  }
  const nameResult = await resolveZoneName(baseName, settings);
  if (!nameResult.success) {
    return { problem: { status: nameResult.error.status, payload: nameResult.error } };
  }
  const conflict = await findExistingZoneConflict(nameResult.finalZoneName);
  if (conflict) {
    return { problem: { status: 409, payload: conflict } };
  }
  const boxResolution = await resolveBoxToTemplate(settings, hostBody.disks);
  if (!boxResolution.success) {
    return {
      problem: {
        status: boxResolution.error.status || 400,
        payload: {
          error: `${label}: every template must be local — auto-download is single-host only`,
          details: boxResolution.error,
        },
      },
    };
  }
  hostBody.name = baseName;
  enrichBootTemplate(hostBody, boxResolution);
  const strategyProblem = await bootStrategyProblem(hostBody);
  if (strategyProblem) {
    return {
      problem: { status: 400, payload: { error: `${label}: ${strategyProblem}` } },
    };
  }
  const resourceValidation = await validateZoneCreationResources(hostBody);
  if (!resourceValidation.valid) {
    return {
      problem: {
        status: 400,
        payload: {
          error: 'Insufficient resources',
          details: resourceValidation.errors.map(detail => ({
            ...detail,
            entry: index + 1,
            machine_name: nameResult.finalZoneName,
          })),
        },
      },
    };
  }
  const warnings = [...resourceValidation.warnings, ...diskPrep.warnings];
  const firmwareWarning = firmwareConflictWarning(hostBody);
  if (firmwareWarning) {
    warnings.push(firmwareWarning);
  }
  return {
    finalZoneName: nameResult.finalZoneName,
    hostBody,
    warnings,
  };
};

/**
 * Multi-host create (§5 hosts[]): ONE rendered document → N coordinated
 * machines. Every host validates/conflict-checks BEFORE anything is created
 * (atomic refusal); creation chains in DECLARATION ORDER — machine k+1's
 * first task gates on machine k's last (finalize, or start when
 * start_after_create rides), so join vars written by earlier machines'
 * provisioning hold when later machines come up.
 * @param {Object} req - Request
 * @param {Object} res - Response
 * @param {Array<Object>} hostBodies - Per-machine create bodies
 * @returns {Promise<Object>} Response
 */
export const createMultiHostMachines = async (req, res, hostBodies) => {
  try {
    const phase1 = await hostBodies.reduce(
      (promise, hostBody, index) =>
        promise.then(async acc => {
          if (acc.problem) {
            return acc;
          }
          const entry = await prepareMultiHostEntry(hostBody, index);
          if (entry.problem) {
            return { ...acc, problem: entry.problem };
          }
          if (acc.seenNames.has(entry.finalZoneName)) {
            return {
              ...acc,
              problem: {
                status: 400,
                payload: {
                  error: `multi-host document names ${entry.finalZoneName} more than once`,
                },
              },
            };
          }
          acc.seenNames.add(entry.finalZoneName);
          acc.prepared.push(entry);
          return acc;
        }),
      Promise.resolve({ prepared: [], seenNames: new Set(), problem: null })
    );
    if (phase1.problem) {
      return res.status(phase1.problem.status).json(phase1.problem.payload);
    }

    const networkSetup = await ensureProvisioningNetwork(req.entity.name);

    const machines = [];
    const warnings = {};
    await phase1.prepared.reduce(
      (promise, { finalZoneName, hostBody, warnings: hostWarnings }) =>
        promise.then(async previousLast => {
          const parentTask = await Tasks.create({
            zone_name: finalZoneName,
            operation: 'zone_create_orchestration',
            priority: TaskPriority.MEDIUM,
            created_by: req.entity.name,
            metadata: JSON.stringify(hostBody),
            status: 'running',
            started_at: new Date(),
          });
          const { subTasks } = await createZoneCreationSubTasks(
            finalZoneName,
            hostBody,
            parentTask.id,
            previousLast,
            hostBody.start_after_create,
            req.entity.name
          );
          machines.push({
            machine_name: finalZoneName,
            parent_task_id: parentTask.id,
            sub_tasks: subTasks,
          });
          if (hostWarnings?.length > 0) {
            warnings[finalZoneName] = hostWarnings;
          }
          return subTasks.start || subTasks.stage || subTasks.finalize;
        }),
      Promise.resolve(networkSetup?.lastTaskId ?? null)
    );

    const response = {
      success: true,
      multi_host: true,
      count: machines.length,
      message: `Multi-host creation queued — ${machines.length} machines in document order`,
      machines,
    };
    if (networkSetup) {
      response.network_setup = networkSetup.parentTaskId;
    }
    if (Object.keys(warnings).length > 0) {
      response.resource_warnings = warnings;
    }
    return res.json(response);
  } catch (error) {
    log.api.error('Multi-host creation failed', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Failed to queue multi-host creation', details: error.message });
  }
};
