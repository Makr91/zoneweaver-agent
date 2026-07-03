/**
 * @fileoverview Zlogin Automation Engine for Zoneweaver Agent
 * @description Expect-like automation engine for programmatic zlogin console interaction.
 *              Executes recipes against zones for early-boot configuration (network, user creation)
 *              BEFORE SSH is available. Backend automation service, separate from the interactive
 *              WebSocket terminal in ZloginController.js.
 */

import { log } from './Logger.js';
import { ptyManager } from './ZloginPtyManager.js';

/**
 * Zlogin Automation Engine
 * Spawns a zlogin console session and executes recipe steps programmatically.
 */
class ZloginAutomation {
  /**
   * @param {string} zoneName - Name of the zone to connect to
   * @param {Object} [options]
   * @param {number} [options.cols=80] - Terminal columns
   * @param {number} [options.rows=30] - Terminal rows
   * @param {number} [options.defaultTimeout=30000] - Default timeout for wait steps (ms)
   * @param {number} [options.globalTimeout=300000] - Global timeout for entire recipe (ms)
   */
  constructor(zoneName, options = {}) {
    this.zoneName = zoneName;
    this.cols = options.cols || 80;
    this.rows = options.rows || 30;
    this.defaultTimeout = options.defaultTimeout || 30000;
    this.globalTimeout = options.globalTimeout || 300000;
    this.executionLog = [];
    this.destroyed = false;
  }

  /**
   * Execute a recipe against the zone
   * @param {Object} recipe - Recipe object with steps and metadata
   * @param {Object} [variables={}] - Variables for template resolution
   * @returns {Promise<{success: boolean, output: string[], errors: string[]}>}
   */
  async execute(recipe, variables = {}) {
    if (this.destroyed) {
      return { success: false, output: [], errors: ['Automation engine has been destroyed'] };
    }

    // Zone provisioning variables override recipe defaults
    const bootString =
      variables.boot_string !== undefined ? variables.boot_string : recipe.boot_string || '';
    const loginPrompt = variables.login_prompt || recipe.login_prompt || 'login:';
    const shellPrompt = variables.shell_prompt || recipe.shell_prompt || ':~$';

    const mergedVars = {
      ...recipe.variables,
      ...variables,
      login_prompt: loginPrompt,
      shell_prompt: shellPrompt,
      boot_string: bootString,
    };

    const errors = [];
    const output = [];
    const globalDeadline = Date.now() + this.globalTimeout;

    try {
      // Get or create shared PTY session
      await ptyManager.getOrCreate(this.zoneName, {
        cols: this.cols,
        rows: this.rows,
      });

      // Mark automation as active
      await ptyManager.setAutomationActive(this.zoneName, true);

      // Clear buffer to start fresh (prevent matching stale data from previous runs)
      ptyManager.clearBuffer(this.zoneName);

      // If boot_string is set, wait for it first
      if (bootString) {
        log.task.info('Waiting for boot string', {
          zone_name: this.zoneName,
          pattern: bootString,
        });
        const bootTimeout = (recipe.timeout_seconds || 300) * 1000;
        const bootResult = await ptyManager.waitForPattern(
          this.zoneName,
          bootString,
          bootTimeout,
          globalDeadline
        );
        if (!bootResult.matched) {
          log.task.warn('Boot string not detected, checking current state', {
            zone_name: this.zoneName,
          });

          // Send newline to trigger a prompt response
          ptyManager.clearBuffer(this.zoneName);
          ptyManager.write(this.zoneName, '\r\n');
          await this._waitForDelay(2000);

          // Check what state we're in
          const buffer = ptyManager.getStrippedBuffer(this.zoneName);

          if (buffer.includes('grub>')) {
            errors.push('Zone stuck at GRUB prompt - manual intervention required');
            return { success: false, output, errors };
          }

          if (buffer.includes(loginPrompt)) {
            log.task.info('Zone already at login prompt, continuing from there', {
              zone_name: this.zoneName,
            });
            output.push('Boot string missed, but zone is at login prompt');
          } else {
            errors.push(`Boot wait timed out and could not detect zone state`);
            return { success: false, output, errors };
          }
        } else {
          output.push(`Boot detected: ${bootString}`);
        }
      }

      // Send newline to trigger fresh prompt (like vagrant-zones zloginboot)
      if (ptyManager.isAlive(this.zoneName)) {
        ptyManager.write(this.zoneName, '\r\n');
        await this._waitForDelay(1000);
      }

      // Execute each step
      const executeSteps = async index => {
        if (index >= recipe.steps.length) {
          return;
        }

        if (this.destroyed) {
          errors.push('Automation was cancelled');
          return;
        }

        if (Date.now() >= globalDeadline) {
          errors.push('Global timeout exceeded');
          return;
        }

        const step = recipe.steps[index];
        const stepResult = await this._executeStep(step, mergedVars, globalDeadline);
        this.executionLog.push({
          step: index,
          type: step.type,
          ...stepResult,
        });

        if (stepResult.output) {
          output.push(stepResult.output);
        }

        if (!stepResult.success) {
          errors.push(stepResult.error || `Step ${index} (${step.type}) failed`);
          return;
        }

        await executeSteps(index + 1);
      };

      await executeSteps(0);
    } catch (error) {
      errors.push(`Execution error: ${error.message}`);
    } finally {
      // Mark automation as inactive (but don't destroy the PTY - frontend may be using it)
      await ptyManager.setAutomationActive(this.zoneName, false);
    }

    return {
      success: errors.length === 0,
      output,
      errors,
      log: this.executionLog,
    };
  }

  /**
   * Execute a single recipe step
   * @param {Object} step - Step definition
   * @param {Object} vars - Resolved variables
   * @param {number} globalDeadline - Absolute deadline timestamp
   * @returns {Promise<{success: boolean, output?: string, error?: string}>}
   * @private
   */
  _executeStep(step, vars, globalDeadline) {
    switch (step.type) {
      case 'wait':
        return this._stepWait(step, vars, globalDeadline);
      case 'send':
        return this._stepSend(step, vars);
      case 'command':
        return this._stepCommand(step, vars, globalDeadline);
      case 'template':
        return this._stepTemplate(step, vars, globalDeadline);
      case 'delay':
        return this._stepDelay(step);
      default:
        return { success: false, error: `Unknown step type: ${step.type}` };
    }
  }

  /**
   * Wait for a pattern in console output
   * @private
   */
  async _stepWait(step, vars, globalDeadline) {
    const pattern = this._resolveVars(step.pattern, vars);
    const timeout = Math.min(
      (step.timeout || this.defaultTimeout / 1000) * 1000,
      globalDeadline - Date.now()
    );

    const result = await ptyManager.waitForPattern(this.zoneName, pattern, timeout, globalDeadline);
    if (result.matched) {
      return { success: true, output: `Matched pattern: ${pattern}` };
    }
    return { success: false, error: `Timeout waiting for pattern: ${pattern}` };
  }

  /**
   * Send text to the console
   * @private
   */
  _stepSend(step, vars) {
    if (!ptyManager.isAlive(this.zoneName)) {
      return { success: false, error: 'PTY process not available' };
    }

    const value = this._resolveVars(step.value, vars);
    ptyManager.write(this.zoneName, value);
    return { success: true, output: `Sent: ${value.replace(/\r?\n/g, '\\n')}` };
  }

  /**
   * Execute a command and optionally verify exit code
   * @private
   */
  async _stepCommand(step, vars, globalDeadline) {
    if (!ptyManager.isAlive(this.zoneName)) {
      return { success: false, error: 'PTY process not available' };
    }

    const command = this._resolveVars(step.value, vars);
    const expectPrompt = step.expect_prompt
      ? this._resolveVars(step.expect_prompt, vars)
      : this._resolveVars('{{shell_prompt}}', vars);
    const timeout = Math.min(
      (step.timeout || this.defaultTimeout / 1000) * 1000,
      globalDeadline - Date.now()
    );

    // Clear buffer to capture only this command's output
    ptyManager.clearBuffer(this.zoneName);

    // For commands that don't check exit code (like shell spawns), just send command and wait for prompt
    if (step.check_exit_code === false) {
      ptyManager.write(this.zoneName, `${command}\r\n`);

      // Wait for expected prompt
      const promptResult = await ptyManager.waitForPattern(
        this.zoneName,
        expectPrompt,
        timeout,
        globalDeadline
      );

      if (!promptResult.matched) {
        return { success: false, error: `Timeout waiting for prompt: ${expectPrompt}` };
      }

      return {
        success: true,
        output: `Command executed: ${command}`,
      };
    }

    // For normal commands, send with exit code marker
    const marker = `ZWEC_${Date.now()}`;
    ptyManager.write(this.zoneName, `${command}; echo "${marker}:$?"\r\n`);

    // Wait for the exit code marker with a digit (not the command echo which has $?)
    // Use regex to match "ZWEC_xxx:" followed by a digit
    const result = await ptyManager.waitForPattern(
      this.zoneName,
      `${marker}:\\d`,
      timeout,
      globalDeadline,
      { useRegex: true }
    );
    if (!result.matched) {
      return { success: false, error: `Command timed out: ${command}` };
    }

    // Extract exit code from the marker (use stripped buffer)
    // Allow whitespace/newlines between marker and exit code
    const strippedBuffer = ptyManager.getStrippedBuffer(this.zoneName);
    const markerMatch = strippedBuffer.match(new RegExp(`${marker}:\\s*(\\d+)`));
    const exitCode = markerMatch ? parseInt(markerMatch[1], 10) : -1;

    // Debug logging if extraction fails
    if (!markerMatch) {
      log.task.error('Failed to extract exit code from marker', {
        zone_name: this.zoneName,
        marker,
        command,
        buffer_length: strippedBuffer.length,
        buffer_preview: strippedBuffer.substring(Math.max(0, strippedBuffer.length - 200)),
      });
    }

    if (exitCode !== 0) {
      return {
        success: false,
        error: `Command failed with exit code ${exitCode}: ${command}`,
        output: strippedBuffer,
      };
    }

    // Wait for shell prompt to return
    await ptyManager.waitForPattern(this.zoneName, expectPrompt, 5000, globalDeadline);

    return {
      success: true,
      output: `Command executed (exit ${exitCode}): ${command}`,
    };
  }

  /**
   * Write a template file to the zone via echo redirection
   * @private
   */
  async _stepTemplate(step, vars, globalDeadline) {
    if (!ptyManager.isAlive(this.zoneName)) {
      return { success: false, error: 'PTY process not available' };
    }

    const content = this._resolveVars(step.content, vars);
    const dest = this._resolveVars(step.dest, vars);
    const method = step.method || 'echo_redirect';
    const timeout = Math.min((step.timeout || 30) * 1000, globalDeadline - Date.now());

    if (method === 'echo_redirect') {
      // Write content line by line via echo redirection
      const lines = content.split('\n');

      // First line creates/truncates the file
      ptyManager.write(this.zoneName, `echo '${this._escapeShell(lines[0])}' > ${dest}\r\n`);
      await this._waitForDelay(200);

      // Remaining lines append

      const writeLines = async index => {
        if (index >= lines.length) {
          return;
        }
        ptyManager.write(this.zoneName, `echo '${this._escapeShell(lines[index])}' >> ${dest}\r\n`);
        await this._waitForDelay(200);
        await writeLines(index + 1);
      };

      await writeLines(1);

      // Wait for prompt to return
      const expectPrompt = this._resolveVars(step.expect_prompt || '{{shell_prompt}}', vars);
      await ptyManager.waitForPattern(this.zoneName, expectPrompt, timeout, globalDeadline);

      return { success: true, output: `Template written to ${dest}` };
    } else if (method === 'heredoc') {
      const marker = `ZWEOD_${Date.now()}`;
      ptyManager.write(this.zoneName, `cat > ${dest} << '${marker}'\r\n`);
      ptyManager.write(this.zoneName, `${content}\r\n`);
      ptyManager.write(this.zoneName, `${marker}\r\n`);

      // Wait for prompt
      const expectPrompt = this._resolveVars(step.expect_prompt || '{{shell_prompt}}', vars);
      await ptyManager.waitForPattern(this.zoneName, expectPrompt, timeout, globalDeadline);

      return { success: true, output: `Template written to ${dest} (heredoc)` };
    }

    return { success: false, error: `Unknown template method: ${method}` };
  }

  /**
   * Delay for a specified number of seconds
   * @private
   */
  async _stepDelay(step) {
    const seconds = step.seconds || 1;
    await this._waitForDelay(seconds * 1000);
    return { success: true, output: `Delayed ${seconds}s` };
  }

  /**
   * Wait for a specified delay
   * @param {number} ms - Milliseconds to wait
   * @returns {Promise<void>}
   * @private
   */
  _waitForDelay(ms) {
    return new Promise(resolve => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Resolve {{variable}} placeholders in a string
   * @param {string} str - String with placeholders
   * @param {Object} vars - Variable map
   * @returns {string}
   * @private
   */
  _resolveVars(str, vars) {
    if (!str) {
      return str;
    }
    return str.replace(/\{\{(?<varname>\w+)\}\}/gu, (match, ...args) => {
      const { varname } = args[args.length - 1];
      return vars[varname] !== undefined ? vars[varname] : match;
    });
  }

  /**
   * Escape string for use in shell single quotes
   * @param {string} str - String to escape
   * @returns {string}
   * @private
   */
  _escapeShell(str) {
    return str.replace(/'/g, "'\\''");
  }

  /**
   * Get the current output buffer contents
   * @returns {string}
   */
  getOutput() {
    return ptyManager.getRawBuffer(this.zoneName);
  }

  /**
   * Get the execution log
   * @returns {Array}
   */
  getLog() {
    return this.executionLog;
  }

  /**
   * Destroy the automation engine and release automation lock
   * NOTE: Does NOT kill the PTY - frontend may still be using it
   */
  async destroy() {
    this.destroyed = true;

    // Release automation lock (PTY stays alive for frontend)
    await ptyManager.setAutomationActive(this.zoneName, false);

    log.task.info('Zlogin automation engine destroyed (PTY preserved for frontend)', {
      zone_name: this.zoneName,
    });
  }
}

export default ZloginAutomation;
