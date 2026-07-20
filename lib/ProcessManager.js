/**
 * @fileoverview Process Manager for Zoneweaver Agent
 * @description Provides an interface for managing processes on OmniOS using advanced process management tools
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { log, createTimer } from './Logger.js';

const execAsync = promisify(exec);

/**
 * Output ceiling for a command's stdout. Node's exec defaults to 1MB and
 * REJECTS with ENOBUFS past it — `zfs list` on a host with many datasets, or
 * `zpool status -v` on a large array, blows straight through that and the
 * collector sees a hard failure instead of its data.
 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Executes a shell command and returns its stdout.
 *
 * The `timeout` was previously accepted by every caller and honoured by NONE —
 * this function took a single parameter, so `executeCommand(cmd, { timeout })`
 * silently dropped it and a hung command (a wedged `zpool status`, a `format`
 * waiting on a dead device) blocked its collector forever. The option is real
 * now: exec kills the child when it expires and the rejection says so.
 * @param {string} command - The command to execute.
 * @param {Object} [options] - Execution options.
 * @param {number} [options.timeout] - Milliseconds before the child is killed.
 * @returns {Promise<string>} The stdout of the command.
 * @throws {Error} On a non-zero exit, or when the timeout kills the command.
 */
export const executeCommand = async (command, options = {}) => {
  const timer = createTimer('process_command');
  const { timeout } = options;
  const execOptions = { maxBuffer: MAX_OUTPUT_BYTES };
  if (Number.isFinite(timeout) && timeout > 0) {
    execOptions.timeout = timeout;
  }

  try {
    const { stdout, stderr } = await execAsync(command, execOptions);
    const duration = timer.end();

    if (stderr && stderr.trim()) {
      log.task.warn('Command executed with stderr', {
        command: command.substring(0, 100),
        stderr: stderr.trim(),
        duration_ms: duration,
      });
    }

    return stdout.trim();
  } catch (error) {
    const duration = timer.end();

    // exec signals a timeout by KILLING the child — surface that as itself
    // rather than as an anonymous failure, so a wedged command is diagnosable.
    if (execOptions.timeout && error.killed) {
      log.task.error('Command execution timeout', {
        command: command.substring(0, 100),
        timeout_ms: execOptions.timeout,
        duration_ms: duration,
      });
      throw new Error(
        `Command timed out after ${execOptions.timeout}ms: ${command.substring(0, 100)}`
      );
    }

    log.task.error('Command execution failed', {
      command: command.substring(0, 100),
      error: error.message,
      exit_code: error.code,
      stderr: error.stderr,
      duration_ms: duration,
    });
    throw error;
  }
};

/**
 * prstat size spellings ("4096K", "1.5M") → bytes (converged structured-JSON
 * wire 2026-07-20: numerics, no formatted twins). Null when unparseable.
 * @param {string} text - prstat size token
 * @returns {number|null} Bytes
 */
const sizeToBytes = text => {
  const match = String(text).match(/^(?<num>[\d.]+)(?<unit>[KMGTP]?)$/u);
  if (!match) {
    return null;
  }
  const units = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };
  return Math.round(Number(match.groups.num) * units[match.groups.unit]);
};

/**
 * prstat/ps time spellings ("0:00:12", "12:34") → whole seconds (same
 * converged wire). Null when unparseable.
 * @param {string} text - Clock-style time token
 * @returns {number|null} Seconds
 */
const timeToSeconds = text => {
  const parts = String(text).split(':').map(Number);
  if (parts.length === 0 || parts.some(Number.isNaN)) {
    return null;
  }
  return parts.reduce((acc, part) => acc * 60 + part, 0);
};

/**
 * Parses the output of the `prstat` command into structured JSON format.
 * @param {string} prstatOutput - The raw output from the `prstat` command.
 * @returns {Array<Object>} An array of process objects.
 */
const parsePrstatOutput = prstatOutput => {
  const lines = prstatOutput.split('\n');
  const processes = [];

  // Find the header line and data lines
  let dataStartIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('PID') && lines[i].includes('USERNAME')) {
      dataStartIndex = i + 1;
      break;
    }
  }

  if (dataStartIndex === -1) {
    return processes;
  }

  // Parse each process line
  for (let i = dataStartIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && !line.startsWith('Total:') && !line.includes('load averages')) {
      const parts = line.split(/\s+/);
      if (parts.length >= 13) {
        processes.push({
          pid: parseInt(parts[0]),
          username: parts[1],
          size: sizeToBytes(parts[2]),
          rss: sizeToBytes(parts[3]),
          state: parts[4],
          pri: parseInt(parts[5]),
          nice: parseInt(parts[6]),
          cpu_time: timeToSeconds(parts[7]),
          cpu_percent: parseFloat(parts[8]),
          command: parts.slice(12).join(' '),
        });
      }
    }
  }

  return processes;
};

/**
 * Parses the output of the basic `ps` command into structured JSON format.
 * @param {string} psOutput - The raw output from the `ps` command.
 * @returns {Array<Object>} An array of process objects.
 */
const parseBasicPsOutput = psOutput => {
  const lines = psOutput.split('\n');
  const processes = [];

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      const parts = line.split(/\s+/);
      if (parts.length >= 9) {
        processes.push({
          username: parts[0],
          pid: parseInt(parts[1]),
          ppid: parseInt(parts[2]),
          uid: parseInt(parts[3]),
          gid: parseInt(parts[4]),
          sid: parseInt(parts[5]),
          zone: parts[6],
          tty: parts[7],
          command: parts.slice(8).join(' '),
        });
      }
    }
  }

  return processes;
};

/**
 * Parses the output of detailed `ps auxww` or extended ps command into structured JSON format.
 * @param {string} psOutput - The raw output from the detailed ps command.
 * @returns {Array<Object>} An array of process objects with CPU/memory stats.
 */
const parseDetailedPsOutput = psOutput => {
  const lines = psOutput.split('\n');
  const processes = [];

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      const parts = line.split(/\s+/);

      // Check if this is ps auxww format or extended format
      if (parts.length >= 11 && parts[0] !== 'USER') {
        if (line.includes('%CPU') || parts[2] === undefined) {
          continue; // Skip header lines
        }

        // Determine format based on number of fields
        if (parts.length >= 15) {
          // Extended format with zone: user,pid,ppid,uid,gid,zone,tty,pcpu,pmem,vsz,rss,state,etime,time,comm
          processes.push({
            username: parts[0],
            pid: parseInt(parts[1]),
            ppid: parseInt(parts[2]),
            uid: parseInt(parts[3]),
            gid: parseInt(parts[4]),
            zone: parts[5],
            tty: parts[6],
            cpu_percent: parseFloat(parts[7]),
            memory_percent: parseFloat(parts[8]),
            vsz: parseInt(parts[9]),
            rss: parseInt(parts[10]),
            state: parts[11],
            elapsed_time: parts[12],
            cpu_time: parts[13],
            command: parts.slice(14).join(' '),
          });
        } else {
          // ps auxww format: USER PID %CPU %MEM VSZ RSS TTY S START TIME COMMAND
          const commandStart = 10;
          processes.push({
            username: parts[0],
            pid: parseInt(parts[1]),
            cpu_percent: parseFloat(parts[2]),
            memory_percent: parseFloat(parts[3]),
            vsz: parseInt(parts[4]),
            rss: parseInt(parts[5]),
            tty: parts[6],
            state: parts[7],
            start_time: parts[8],
            cpu_time: parts[9],
            command: parts.slice(commandStart).join(' '),
          });
        }
      }
    }
  }

  return processes;
};

/**
 * Get list of processes with advanced filtering options
 * @param {Object} options - Filtering and display options
 * @param {string} options.zone - Filter by zone name
 * @param {string} options.user - Filter by username
 * @param {string} options.command - Filter by command pattern
 * @param {boolean} options.detailed - Include CPU/memory stats (uses ps auxww)
 * @param {number} options.limit - Limit number of results
 * @returns {Promise<Array<Object>>} Array of process objects
 */
export const getProcesses = async (options = {}) => {
  let command;

  if (options.detailed) {
    if (options.zone) {
      // Zone-filtered detailed process list
      command = `pfexec ps -z ${options.zone} -o user,pid,ppid,uid,gid,zone,tty,pcpu,pmem,vsz,rss,state,etime,time,comm`;
    } else {
      // All processes with detailed CPU/memory information
      command = 'pfexec ps auxww';
    }
  } else if (options.zone) {
    // Zone-filtered basic process list
    command = `pfexec ps -z ${options.zone} -o user,pid,ppid,uid,gid,sid,zone,tty,comm`;
  } else {
    // All processes basic list - use -eZ to include zone info
    command = 'pfexec ps -eZo user,pid,ppid,uid,gid,sid,zone,tty,comm';
  }

  const output = await executeCommand(command);
  const processes = options.detailed ? parseDetailedPsOutput(output) : parseBasicPsOutput(output);

  // Apply additional filtering
  let filteredProcesses = processes;

  if (options.user) {
    filteredProcesses = filteredProcesses.filter(
      proc => proc.username === options.user || proc.uid === options.user
    );
  }

  if (options.command) {
    const commandPattern = new RegExp(options.command, 'i');
    filteredProcesses = filteredProcesses.filter(proc => commandPattern.test(proc.command));
  }

  if (options.limit) {
    filteredProcesses = filteredProcesses.slice(0, options.limit);
  }

  return filteredProcesses;
};

/**
 * Get detailed information about a specific process
 * @param {number} pid - Process ID
 * @returns {Promise<Object>} Detailed process information
 */
export const getProcessDetails = async pid => {
  try {
    // Get basic process info
    const psCommand = `pfexec ps -p ${pid} -o pid,ppid,uid,gid,sid,zone,tty,time,vsz,rss,args`;
    const psOutput = await executeCommand(psCommand);

    // Parse ps output
    const lines = psOutput.split('\n');
    if (lines.length < 2) {
      throw new Error(`Process ${pid} not found`);
    }

    const processLine = lines[1].trim().split(/\s+/);
    const processInfo = {
      pid: parseInt(processLine[0]),
      ppid: parseInt(processLine[1]),
      uid: parseInt(processLine[2]),
      gid: parseInt(processLine[3]),
      sid: parseInt(processLine[4]),
      zone: processLine[5],
      tty: processLine[6],
      time: processLine[7],
      vsz: parseInt(processLine[8]),
      rss: parseInt(processLine[9]),
      command: processLine.slice(10).join(' '),
    };

    // Get additional details using pfiles, pstack, etc. if available
    try {
      const pfilesOutput = await executeCommand(`pfexec pfiles ${pid} 2>/dev/null | head -20`);
      processInfo.open_files_sample = pfilesOutput.split('\n').filter(line => line.trim());
    } catch (error) {
      log.task.debug('Unable to retrieve process file information', {
        pid,
        error: error.message,
      });
      processInfo.open_files_sample = [];
    }

    return processInfo;
  } catch (error) {
    if (error.message.includes('No such process')) {
      throw new Error(`Process ${pid} not found`);
    }
    throw error;
  }
};

/**
 * Send a signal to a process
 * @param {number} pid - Process ID
 * @param {string} signal - Signal name (TERM, KILL, HUP, etc.)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const signalProcess = async (pid, signal = 'TERM') => {
  try {
    const validSignals = ['TERM', 'KILL', 'HUP', 'INT', 'USR1', 'USR2', 'STOP', 'CONT'];
    if (!validSignals.includes(signal)) {
      return {
        success: false,
        error: `Invalid signal: ${signal}. Valid signals: ${validSignals.join(', ')}`,
      };
    }

    await executeCommand(`kill -${signal} ${pid}`);
    return {
      success: true,
      message: `Signal ${signal} sent to process ${pid}`,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to send signal ${signal} to process ${pid}: ${error.message}`,
    };
  }
};

/**
 * Kill a process (sends SIGTERM first, then SIGKILL if needed)
 * @param {number} pid - Process ID
 * @param {boolean} force - If true, send SIGKILL immediately
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const killProcess = async (pid, force = false) => {
  try {
    if (force) {
      return await signalProcess(pid, 'KILL');
    }

    // Try SIGTERM first
    const termResult = await signalProcess(pid, 'TERM');
    if (!termResult.success) {
      return termResult;
    }

    // Wait briefly and check if process is still alive
    await new Promise(resolve => {
      setTimeout(resolve, 2000);
    });

    try {
      await executeCommand(`kill -0 ${pid}`);
      // Process still exists, send SIGKILL
      const killResult = await signalProcess(pid, 'KILL');
      return {
        success: killResult.success,
        message: `Process ${pid} terminated with SIGTERM, then SIGKILL`,
        error: killResult.error,
      };
    } catch {
      // Process no longer exists
      return {
        success: true,
        message: `Process ${pid} terminated with SIGTERM`,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to kill process ${pid}: ${error.message}`,
    };
  }
};

/**
 * Get open files for a process
 * @param {number} pid - Process ID
 * @returns {Promise<Array<Object>>} Array of open file objects
 */
export const getProcessFiles = async pid => {
  try {
    const output = await executeCommand(`pfexec pfiles ${pid}`);
    const files = [];
    const lines = output.split('\n');

    let currentFd = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.match(/^\d+:/)) {
        // File descriptor line
        currentFd = {
          fd: parseInt(trimmed.split(':')[0]),
          description: trimmed.split(':')[1]?.trim() || '',
        };
        files.push(currentFd);
      } else if (currentFd && trimmed) {
        // Additional file information
        currentFd.details = `${currentFd.details || ''} ${trimmed}`;
      }
    }

    return files;
  } catch (error) {
    throw new Error(`Failed to get files for process ${pid}: ${error.message}`);
  }
};

/**
 * Get process stack trace
 * @param {number} pid - Process ID
 * @returns {Promise<string>} Stack trace output
 */
export const getProcessStack = async pid => {
  try {
    const output = await executeCommand(`pfexec pstack ${pid}`);
    return output;
  } catch (error) {
    throw new Error(`Failed to get stack trace for process ${pid}: ${error.message}`);
  }
};

/**
 * Get process resource limits
 * @param {number} pid - Process ID
 * @returns {Promise<Object>} Resource limits information
 */
export const getProcessLimits = async pid => {
  try {
    const output = await executeCommand(`pfexec plimit ${pid}`);
    const limits = {};
    const lines = output.split('\n');

    for (const line of lines) {
      if (line.includes(':')) {
        const parts = line.split(':');
        if (parts.length >= 2) {
          const key = parts[0].trim().toLowerCase().replace(/\s+/g, '_');
          const value = parts[1].trim();
          limits[key] = value;
        }
      }
    }

    return limits;
  } catch (error) {
    throw new Error(`Failed to get limits for process ${pid}: ${error.message}`);
  }
};

/**
 * Find processes by name using pgrep
 * @param {string} pattern - Process name pattern
 * @param {Object} options - Additional options
 * @param {string} options.zone - Filter by zone
 * @param {string} options.user - Filter by user
 * @param {boolean} options.fullCommandLine - Use -f flag to match full command line
 * @returns {Promise<Array<number>>} Array of process IDs
 */
export const findProcesses = async (pattern, options = {}) => {
  try {
    let command = `pfexec pgrep`;

    if (options.fullCommandLine) {
      command += ` -F`;
    }

    if (options.user) {
      command += ` -u ${options.user}`;
    }

    if (options.zone) {
      command += ` -z ${options.zone}`;
    }

    command += ` "${pattern}"`;

    const output = await executeCommand(command);
    return output
      .split('\n')
      .filter(line => line.trim())
      .map(pid => parseInt(pid))
      .filter(pid => !isNaN(pid));
  } catch (error) {
    // pgrep returns non-zero when no processes found
    if (error.code === 1) {
      return [];
    }
    throw error;
  }
};

/**
 * Kill multiple processes by pattern
 * @param {string} pattern - Process name pattern
 * @param {Object} options - Additional options
 * @param {string} options.zone - Filter by zone
 * @param {string} options.user - Filter by user
 * @param {string} options.signal - Signal to send (default: TERM)
 * @returns {Promise<{success: boolean, killed: Array<number>, errors: Array<Object>}>}
 */
export const killProcessesByPattern = async (pattern, options = {}) => {
  try {
    const pids = await findProcesses(pattern, options);
    if (pids.length === 0) {
      return {
        success: true,
        killed: [],
        errors: [],
        message: 'No processes found matching pattern',
      };
    }

    const results = {
      success: true,
      killed: [],
      errors: [],
    };

    const signal = options.signal || 'TERM';

    // Use Promise.all for parallel process signaling (major performance improvement)
    const signalPromises = pids.map(async pid => {
      const result = await signalProcess(pid, signal);
      return { pid, result };
    });

    const signalResults = await Promise.all(signalPromises);

    // Process results
    for (const { pid, result } of signalResults) {
      if (result.success) {
        results.killed.push(pid);
      } else {
        results.errors.push({ pid, error: result.error });
        results.success = false;
      }
    }

    return results;
  } catch (error) {
    return {
      success: false,
      killed: [],
      errors: [{ error: error.message }],
    };
  }
};

/**
 * Get real-time process statistics
 * @param {Object} options - Options for statistics
 * @param {string} options.zone - Filter by zone
 * @param {number} options.interval - Update interval in seconds
 * @param {number} options.count - Number of samples
 * @returns {Promise<Array<Object>>} Array of process statistics
 */
export const getProcessStats = async (options = {}) => {
  try {
    let command = `pfexec prstat -c`;

    if (options.zone) {
      command += ` -z ${options.zone}`;
    }

    const interval = options.interval || 1;
    const count = options.count || 1;

    command += ` -n ${count} ${interval}`;

    const output = await executeCommand(command);
    return parsePrstatOutput(output);
  } catch (error) {
    throw new Error(`Failed to get process statistics: ${error.message}`);
  }
};
