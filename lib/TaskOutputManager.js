/**
 * @fileoverview Task Output Manager for Zoneweaver Agent
 * @description Manages real-time output streaming for TaskQueue tasks.
 *              Buffers output in-memory, broadcasts to WebSocket subscribers,
 *              periodically flushes to database, and writes log files on completion.
 *              Follows the ZloginPtyManager pattern (subscriber Set, singleton class).
 */

import fs from 'fs';
import path from 'path';
import config from '../config/ConfigLoader.js';
import Tasks from '../models/TaskModel.js';
import { log } from './Logger.js';

/**
 * Get task output configuration from config
 * @returns {Object} Task output config with defaults
 */
const getOutputConfig = () => {
  const provConfig = config.get('provisioning') || {};
  const outputConfig = provConfig.task_output || {};
  return {
    enabled: outputConfig.enabled !== false,
    mode: outputConfig.mode || 'full',
    circularMaxLines: outputConfig.circular_max_lines || 10000,
    flushIntervalMs: (outputConfig.flush_interval_seconds || 10) * 1000,
    persistLogFile: outputConfig.persist_log_file !== false,
    logDirectory: outputConfig.log_directory || '/var/log/zoneweaver-agent/tasks',
  };
};

/**
 * Centralized output manager for task execution output
 * Maintains in-memory buffers, broadcasts to subscribers, flushes to DB
 */
class TaskOutputManager {
  constructor() {
    /** @type {Map<string, {buffer: Array, subscribers: Set, flushTimer: NodeJS.Timeout|null, totalSize: number}>} */
    this.sessions = new Map();
  }

  /**
   * Create a new output session for a task
   * @param {string} taskId - Task UUID
   */
  create(taskId) {
    const outputConfig = getOutputConfig();
    if (!outputConfig.enabled) {
      return;
    }

    if (this.sessions.has(taskId)) {
      return;
    }

    this.sessions.set(taskId, {
      buffer: [],
      subscribers: new Set(),
      flushTimer: null,
      totalSize: 0,
    });

    log.task.debug('Task output session created', { task_id: taskId });
  }

  /**
   * Write output data to a task's buffer
   * @param {string} taskId - Task UUID
   * @param {{stream: string, data: string}} chunk - Output chunk with stream type
   */
  write(taskId, chunk) {
    const session = this.sessions.get(taskId);
    if (!session) {
      return;
    }

    const entry = {
      stream: chunk.stream,
      data: chunk.data,
      timestamp: Date.now(),
    };

    session.buffer.push(entry);
    session.totalSize += chunk.data.length;

    // Enforce circular buffer if configured
    const outputConfig = getOutputConfig();
    if (outputConfig.mode === 'circular' && session.buffer.length > outputConfig.circularMaxLines) {
      const excess = session.buffer.length - outputConfig.circularMaxLines;
      session.buffer.splice(0, excess);
    }

    // Notify all subscribers
    session.subscribers.forEach(callback => {
      try {
        callback(entry);
      } catch (error) {
        log.task.error('Error in task output subscriber callback', {
          task_id: taskId,
          error: error.message,
        });
      }
    });

    // Schedule periodic DB flush
    if (!session.flushTimer) {
      session.flushTimer = setTimeout(() => {
        session.flushTimer = null;
        this.flushToDb(taskId).catch(error => {
          log.task.error('Task output DB flush failed', {
            task_id: taskId,
            error: error.message,
          });
        });
      }, outputConfig.flushIntervalMs);
    }
  }

  /**
   * Subscribe to task output
   * @param {string} taskId - Task UUID
   * @param {Function} callback - Called with each output entry {stream, data, timestamp}
   * @returns {Function} Unsubscribe function
   */
  subscribe(taskId, callback) {
    const session = this.sessions.get(taskId);
    if (!session) {
      return () => {};
    }

    session.subscribers.add(callback);

    log.task.debug('Task output subscriber added', {
      task_id: taskId,
      subscriber_count: session.subscribers.size,
    });

    return () => {
      session.subscribers.delete(callback);
      log.task.debug('Task output subscriber removed', {
        task_id: taskId,
        subscriber_count: session.subscribers.size,
      });
    };
  }

  /**
   * Get current buffer for a task (for reconnection replay)
   * @param {string} taskId - Task UUID
   * @returns {Array} Buffer entries
   */
  getBuffer(taskId) {
    const session = this.sessions.get(taskId);
    return session ? [...session.buffer] : [];
  }

  /**
   * Check if a session exists for a task
   * @param {string} taskId - Task UUID
   * @returns {boolean} True if session exists
   */
  hasSession(taskId) {
    return this.sessions.has(taskId);
  }

  /**
   * Finalize a task output session
   * Flushes remaining output to DB, writes log file, cleans up in-memory state
   * @param {string} taskId - Task UUID
   */
  async finalize(taskId) {
    const session = this.sessions.get(taskId);
    if (!session) {
      return;
    }

    // Clear pending flush timer
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }

    // Final flush to DB
    await this.flushToDb(taskId);

    // Write log file if configured
    const outputConfig = getOutputConfig();
    if (outputConfig.persistLogFile && session.buffer.length > 0) {
      this.writeLogFile(taskId, session.buffer);
    }

    // Notify subscribers of completion
    session.subscribers.forEach(callback => {
      try {
        callback({ stream: 'system', data: 'finalized', timestamp: Date.now() });
      } catch (error) {
        log.task.error('Error notifying subscriber of finalization', {
          task_id: taskId,
          error: error.message,
        });
      }
    });

    // Clean up
    this.sessions.delete(taskId);
    log.task.debug('Task output session finalized', {
      task_id: taskId,
      total_entries: session.buffer.length,
      total_size: session.totalSize,
    });
  }

  /**
   * Flush buffer to database
   * @param {string} taskId - Task UUID
   * @private
   */
  async flushToDb(taskId) {
    const session = this.sessions.get(taskId);
    if (!session || session.buffer.length === 0) {
      return;
    }

    try {
      const outputJson = JSON.stringify(session.buffer);
      await Tasks.update({ output: outputJson }, { where: { id: taskId } });
    } catch (error) {
      log.task.error('Failed to flush task output to DB', {
        task_id: taskId,
        error: error.message,
      });
    }
  }

  /**
   * Write task output to a log file
   * @param {string} taskId - Task UUID
   * @param {Array} buffer - Output buffer entries
   * @private
   */
  writeLogFile(taskId, buffer) {
    const outputConfig = getOutputConfig();

    try {
      // Ensure log directory exists
      fs.mkdirSync(outputConfig.logDirectory, { recursive: true });

      const logPath = path.join(outputConfig.logDirectory, `${taskId}.log`);
      const lines = buffer.map(entry => {
        const ts = new Date(entry.timestamp).toISOString();
        const prefix = entry.stream === 'stderr' ? '[STDERR]' : '[STDOUT]';
        return `${ts} ${prefix} ${entry.data}`;
      });

      fs.writeFileSync(logPath, lines.join(''));
      log.task.debug('Task output log file written', { task_id: taskId, path: logPath });
    } catch (error) {
      log.task.error('Failed to write task output log file', {
        task_id: taskId,
        error: error.message,
      });
    }
  }

  /**
   * Get output for a task (from memory if running, from DB if completed)
   * @param {string} taskId - Task UUID
   * @returns {Promise<Array>} Output entries
   */
  async getOutput(taskId) {
    // Check in-memory first (running task)
    const session = this.sessions.get(taskId);
    if (session) {
      return [...session.buffer];
    }

    // Fall back to DB (completed task)
    try {
      const task = await Tasks.findByPk(taskId, { attributes: ['output'] });
      if (task?.output) {
        return JSON.parse(task.output);
      }
    } catch (error) {
      log.task.error('Failed to retrieve task output from DB', {
        task_id: taskId,
        error: error.message,
      });
    }

    return [];
  }
}

// Singleton instance
export const taskOutputManager = new TaskOutputManager();
