import { AsyncLocalStorage } from 'async_hooks';

/**
 * @fileoverview Per-task run context and controls — the Node analog of the Go
 * queue's context cancellation (D-F). The task processor creates a control
 * per in-flight task; executors run inside taskContext so CommandManager can
 * register every spawned child against the right task; a running-task cancel
 * marks the control and kills the registered children.
 */

/**
 * Pseudo-scopes exempt from per-zone exclusivity: their zone_name is a work
 * bucket, not a machine, so tasks in them may run alongside anything (the Go
 * queue's "system" exemption, widened to zoneweaver's pseudo-zones).
 */
export const EXCLUSIVITY_EXEMPT_SCOPES = new Set(['system', 'artifact', 'filesystem']);

/**
 * Per-task run controls: taskId → {cancelled, children}. `children` holds the
 * live child processes the executor spawned, so a running-task cancel can
 * kill the work in flight.
 * @type {Map<string, {cancelled: boolean, children: Set<import('child_process').ChildProcess>}>}
 */
export const taskControls = new Map();

/**
 * Async context carrying the current task id through an executor's whole call
 * tree, so CommandManager can register spawned children against the right
 * task without every executor threading the task through.
 * @type {AsyncLocalStorage<{taskId: string}>}
 */
export const taskContext = new AsyncLocalStorage();

/**
 * Register a spawned child process against the task currently executing (via
 * taskContext). No-op outside a task context or after the control is gone.
 * @param {import('child_process').ChildProcess} child - Spawned process
 * @returns {Function} Deregistration callback (call on close)
 */
export const registerTaskChild = child => {
  const store = taskContext.getStore();
  const control = store && taskControls.get(store.taskId);
  if (!control) {
    return () => {};
  }
  control.children.add(child);
  return () => {
    control.children.delete(child);
  };
};

/**
 * Whether the currently executing task (or the given id) has been cancelled —
 * long cooperative loops (SSH waits, download streams) consult this to stop
 * between iterations instead of running to their natural end.
 * @param {string} [taskId] - Explicit id; defaults to the ambient task context
 * @returns {boolean} True when a cancel was requested
 */
export const isTaskCancelled = taskId => {
  const id = taskId || taskContext.getStore()?.taskId;
  return id ? taskControls.get(id)?.cancelled === true : false;
};
