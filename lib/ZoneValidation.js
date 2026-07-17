/**
 * @fileoverview Zone Validation Utilities
 * @description General-purpose zone validation functions used across the API
 */

/**
 * Validate zone name format
 * @param {string} zoneName - Zone name to validate
 * @returns {boolean} True if valid, false otherwise
 */
export const validateZoneName = zoneName => {
  if (!zoneName || typeof zoneName !== 'string') {
    return false;
  }

  // Zone names must:
  // - Be alphanumeric with hyphens, underscores, or dots
  // - Be between 1 and 64 characters
  // - Not start or end with special characters
  const validPattern = /^[a-zA-Z0-9][a-zA-Z0-9\-_.]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

  return validPattern.test(zoneName) && zoneName.length <= 64;
};

/**
 * Consoleport pre-flight (cross-agent consensus 2026-07-17): valid range is
 * 1025–65535 and the refusal string is IDENTICAL on both agents. Applies to
 * create (single + multi-host, template-rendered values included) and the
 * PUT consoleport knob. null/'' passes — that spelling clears the pin.
 * @param {*} value - The consoleport value as sent
 * @returns {string|null} The agreed refusal string, or null when valid/absent
 */
export const consoleportRangeError = value => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1025 || num > 65535) {
    return `consoleport ${value} is outside the valid console port range (1025-65535)`;
  }
  return null;
};

/**
 * vcpus pre-flight (cross-agent consensus 2026-07-17, Mark's integer flag):
 * the value must be a WHOLE number ≥ 1 — 2.0 passes (it IS whole, identical
 * outcome on both runtimes), 2.5/non-numeric refuse with the IDENTICAL
 * cross-agent string. Absent/null/'' passes — no change requested. The
 * complex-topology path validates its own integers.
 * @param {*} value - The vcpus value as sent
 * @returns {string|null} The agreed refusal string, or null when valid/absent
 */
export const vcpusCountError = value => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1) {
    return `vcpus ${value} is not a valid vCPU count (whole number >= 1)`;
  }
  return null;
};

/**
 * Validate zone name and return detailed error
 * @param {string} zoneName - Zone name to validate
 * @returns {{valid: boolean, error?: string}} Validation result
 */
export const validateZoneNameDetailed = zoneName => {
  if (!zoneName || typeof zoneName !== 'string') {
    return { valid: false, error: 'Zone name is required and must be a string' };
  }

  if (zoneName.length > 64) {
    return { valid: false, error: 'Zone name must be 64 characters or less' };
  }

  const validPattern = /^[a-zA-Z0-9][a-zA-Z0-9\-_.]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;
  if (!validPattern.test(zoneName)) {
    return {
      valid: false,
      error:
        'Zone name must contain only alphanumeric characters, hyphens, underscores, or dots, and cannot start or end with special characters',
    };
  }

  return { valid: true };
};
