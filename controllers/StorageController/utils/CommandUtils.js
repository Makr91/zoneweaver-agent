/**
 * @fileoverview Storage Command Execution Utilities
 * @description Wrapper functions for ZFS and storage-related command execution
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { executeCommand } from '../../../lib/ProcessManager.js';

/**
 * Execute zpool list command
 * @param {number} timeout - Command timeout in milliseconds
 * @returns {Promise<string>} Command output
 */
export const executeZpoolList = timeout => executeCommand('zpool list -H -o name', { timeout });

/**
 * Execute zoneadm list command
 * @param {number} timeout - Command timeout in milliseconds
 * @returns {Promise<string>} Command output
 */
export const executeZoneList = timeout => executeCommand('pfexec zoneadm list -icv', { timeout });

/**
 * Execute zpool iostat command
 * @param {number} timeout - Command timeout in milliseconds
 * @returns {Promise<string>} Command output
 */
export const executeZpoolIostat = timeout => executeCommand('zpool iostat', { timeout });

/**
 * Execute zpool status command
 * @param {number} timeout - Command timeout in milliseconds
 * @returns {Promise<string>} Command output
 */
export const executeZpoolStatus = timeout => executeCommand('zpool status', { timeout });

/**
 * Execute zfs list command
 * @param {number} timeout - Command timeout in milliseconds
 * @returns {Promise<string>} Command output
 */
export const executeZfsList = timeout => executeCommand('zfs list -H', { timeout });

/**
 * Execute zfs get all command for a specific dataset
 * @param {string} datasetName - Dataset name
 * @param {number} timeout - Command timeout in milliseconds
 * @returns {Promise<string>} Command output
 */
export const executeZfsGetAll = (datasetName, timeout) =>
  executeCommand(`zfs get all "${datasetName}"`, { timeout });

/**
 * Execute zfs list command for a specific dataset
 * @param {string} datasetName - Dataset name
 * @param {number} timeout - Command timeout in milliseconds
 * @returns {Promise<string>} Command output
 */
export const executeZfsListDataset = (datasetName, timeout) =>
  executeCommand(`zfs list -H "${datasetName}"`, { timeout });

/**
 * Execute format command to list disks
 * @param {number} timeout - Command timeout in milliseconds
 * @returns {Promise<string>} Command output
 */
export const executeFormatList = timeout =>
  executeCommand('echo | pfexec format | grep "^[ ]*[0-9]"', { timeout });

/**
 * Execute zpool list command for extended pool information
 * @param {number} timeout - Command timeout in milliseconds
 * @returns {Promise<string>} Command output
 */
export const executeZpoolListExtended = timeout => executeCommand('zpool list -H', { timeout });

/**
 * Execute kstat command for ARC statistics
 * @param {number} timeout - Command timeout in milliseconds
 * @returns {Promise<string>} Command output
 */
export const executeKstatARC = timeout => executeCommand('kstat -p zfs:0:arcstats', { timeout });

/**
 * Execute comprehensive zpool iostat command
 * @param {number} timeout - Command timeout in milliseconds
 * @returns {Promise<string>} Command output
 */
export const executeComprehensiveIostat = timeout =>
  executeCommand('pfexec zpool iostat -l -H -v 1 2', { timeout });

/**
 * Execute commands in parallel with error handling
 * @param {Array<Function>} commands - Array of command functions
 * @param {string} hostname - Hostname for logging
 * @returns {Promise<Array>} Results array with success/failure status
 */
export const executeCommandsParallel = async (commands, hostname) => {
  const results = await Promise.allSettled(
    commands.map(async commandFn => {
      try {
        return await commandFn();
      } catch (error) {
        return { error: error.message, hostname };
      }
    })
  );

  return results.map((result, index) => ({
    success: result.status === 'fulfilled' && !result.value?.error,
    data: result.status === 'fulfilled' ? result.value : null,
    error: result.status === 'rejected' ? result.reason : result.value?.error,
    commandIndex: index,
  }));
};

/**
 * Safe command execution with fallback
 * @param {Function} commandFn - Command function to execute
 * @param {string} operation - Operation name for logging
 * @param {Function} logger - Logger function
 * @param {string} hostname - Hostname for logging
 * @returns {Promise<any>} Command result or empty array on failure
 */
export const safeExecuteCommand = async (commandFn, operation, logger, hostname) => {
  try {
    return await commandFn();
  } catch (error) {
    logger.warn(`Failed to execute ${operation}`, {
      error: error.message,
      hostname,
    });
    return [];
  }
};
