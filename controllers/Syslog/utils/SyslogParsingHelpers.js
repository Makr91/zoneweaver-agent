/**
 * @fileoverview Syslog parsing and validation helpers — selector/action
 * parsing, syslog.conf rule parsing, and configuration validation.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

/**
 * Helper function to parse selector and action
 * @param {string} selector - Selector part (e.g., "*.notice;mail.none")
 * @param {string} action - Action part (e.g., "/var/log/messages")
 * @returns {Object} Parsed selector and action
 */
export const parseSelectorAndAction = (selector, action) => {
  const parsed = {
    selectors: [],
    action_type: 'unknown',
    action_target: action,
  };

  // Parse selectors (semicolon separated)
  const selectorParts = selector.split(';');

  for (const part of selectorParts) {
    const trimmed = part.trim();
    if (trimmed.includes('.')) {
      const [facility, level] = trimmed.split('.');
      parsed.selectors.push({
        facility,
        level,
      });
    } else {
      parsed.selectors.push({
        facility: trimmed,
        level: null,
      });
    }
  }

  // Determine action type
  if (action.startsWith('/')) {
    parsed.action_type = 'file';
  } else if (action.startsWith('@')) {
    parsed.action_type = 'remote_host';
    parsed.action_target = action.substring(1);
  } else if (action === '*') {
    parsed.action_type = 'all_users';
  } else if (action.includes(',')) {
    parsed.action_type = 'specific_users';
    parsed.action_target = action.split(',').map(u => u.trim());
  } else {
    parsed.action_type = 'user';
  }

  return parsed;
};

/**
 * Helper function to parse syslog configuration
 * @param {string} configContent - Syslog configuration content
 * @returns {Array} Parsed rules
 */
export const parseSyslogConfig = configContent => {
  const rules = [];

  if (!configContent) {
    return rules;
  }

  const lines = configContent.split('\n');

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum].trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) {
      continue;
    }

    // Parse selector and action (separated by TAB or multiple spaces)
    const parts = line.split(/\t+|\s{2,}/);
    if (parts.length >= 2) {
      const [selector, ...actionParts] = parts;
      const action = actionParts.join(' ');

      rules.push({
        line_number: lineNum + 1,
        selector,
        action,
        full_line: line,
        parsed: parseSelectorAndAction(selector, action),
      });
    } else {
      rules.push({
        line_number: lineNum + 1,
        full_line: line,
        error: 'Could not parse selector and action',
      });
    }
  }

  return rules;
};

/**
 * Helper function to validate syslog configuration
 * @param {string} configContent - Configuration content to validate
 * @returns {Object} Validation result
 */
export const validateSyslogConfigContent = configContent => {
  const errors = [];
  const warnings = [];
  const parsedRules = [];

  if (!configContent) {
    return { valid: true, errors, warnings, parsed_rules: parsedRules };
  }

  const lines = configContent.split('\n');
  const knownFacilities = [
    'kern',
    'user',
    'mail',
    'daemon',
    'auth',
    'lpr',
    'news',
    'uucp',
    'altcron',
    'authpriv',
    'ftp',
    'ntp',
    'audit',
    'console',
    'cron',
    'local0',
    'local1',
    'local2',
    'local3',
    'local4',
    'local5',
    'local6',
    'local7',
    'mark',
    '*',
  ];
  const knownLevels = [
    'emerg',
    'alert',
    'crit',
    'err',
    'warning',
    'notice',
    'info',
    'debug',
    'none',
  ];

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum].trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) {
      continue;
    }

    // Check for TAB separation
    if (!line.includes('\t') && !line.match(/\s{2,}/)) {
      warnings.push(`Line ${lineNum + 1}: Should use TAB to separate selector from action`);
    }

    // Parse rule
    const parts = line.split(/\t+|\s{2,}/);
    if (parts.length < 2) {
      errors.push(`Line ${lineNum + 1}: Missing action field`);
      continue;
    }

    const [selector, ...actionParts] = parts;
    const action = actionParts.join(' ');

    // Validate selectors
    const selectors = selector.split(';');
    for (const sel of selectors) {
      const trimmed = sel.trim();
      if (trimmed.includes('.')) {
        const [facility, level] = trimmed.split('.');

        if (!knownFacilities.includes(facility)) {
          warnings.push(`Line ${lineNum + 1}: Unknown facility '${facility}'`);
        }

        if (!knownLevels.includes(level)) {
          errors.push(`Line ${lineNum + 1}: Unknown level '${level}'`);
        }
      }
    }

    // Validate action
    if (action.startsWith('/')) {
      // File path - check if directory exists
      const dir = action.substring(0, action.lastIndexOf('/'));
      if (!dir) {
        warnings.push(`Line ${lineNum + 1}: File path should be absolute`);
      }
    } else if (action.startsWith('@')) {
      // Remote host
      const hostname = action.substring(1);
      if (!hostname) {
        errors.push(`Line ${lineNum + 1}: Remote host name required after @`);
      }
    } else if (action !== '*' && !action.match(/^[a-zA-Z][a-zA-Z0-9_,]*$/)) {
      warnings.push(`Line ${lineNum + 1}: Action '${action}' may not be valid`);
    }

    parsedRules.push(parseSelectorAndAction(selector, action));
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    parsed_rules: parsedRules,
  };
};
