/**
 * @fileoverview Field DSL — runtime half (provisioning-design §3.1)
 * @description The manifest's `metadata.configuration = {groups, fields}` drives
 * machine-create forms. This module is the AGENT-AUTHORITATIVE evaluator: the
 * closed show_if grammar, defaults-before-conditionals visibility, and the
 * pre-render answer validation that backs the 422 {FIELD: message} contract.
 * The UI runs the same grammar live (never authoritatively); the shared
 * test-vector file (lib/FieldDslTestVectors.json) keeps both evaluators honest.
 * Import-time lint + schema.json derivation live in FieldDslLint.js.
 */

import net from 'net';

/** Closed type set (§3.1) — unknown type is an import ERROR, fail-closed. */
export const FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'checkbox',
  'select',
  'multiselect',
  'password',
  'fqdn',
  'ipaddr',
  'cidr',
  'path',
];

/** Types whose answers are strings (share the string validate rules). */
export const STRING_TYPES = ['text', 'textarea', 'password', 'fqdn', 'ipaddr', 'cidr', 'path'];

/** select/multiselect live platform pickers (§3.1). */
export const OPTIONS_SOURCES = ['networks', 'datastores', 'hosts', 'images'];

const COMPARATORS = ['gt', 'gte', 'lt', 'lte'];

/** RFC-1123 hostname/FQDN shape (case-insensitive, 253 cap, per-label 63). */
const FQDN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;

/**
 * Normalize a select/multiselect option entry to its VALUE (entries are
 * scalars or {value, label}).
 * @param {*} option - Option entry
 * @returns {*} Option value
 */
export const optionValue = option => (option && typeof option === 'object' ? option.value : option);

/**
 * show_if equality — the Go agent's looseEqual, shared wire rule: when BOTH
 * sides read as numbers they compare numerically ("5" ≡ 5); everything else
 * compares as canonical strings (true ≡ "true"). Booleans never take the
 * numeric path (true ≢ 1).
 * @param {*} a - Operand value
 * @param {*} b - Condition value
 * @returns {boolean} Loose equality
 */
const looseEqual = (a, b) => {
  if (typeof a !== 'boolean' && typeof b !== 'boolean' && a !== '' && b !== '') {
    const an = Number(a);
    const bn = Number(b);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      return an === bn;
    }
  }
  return String(a) === String(b);
};

/**
 * Evaluate ONE condition against an operand's current value. Closed grammar:
 * scalar → looseEqual; array → IN (looseEqual per entry); {not: scalar|array}
 * → negated; {gt|gte|lt|lte: number} → numeric compare (non-numeric
 * operand = false).
 * @param {*} value - Operand's current value (undefined when absent/hidden)
 * @param {*} condition - Condition from the show_if map
 * @returns {boolean} Whether the condition holds
 */
const evaluateCondition = (value, condition) => {
  if (Array.isArray(condition)) {
    return condition.some(entry => looseEqual(value, entry));
  }
  if (condition && typeof condition === 'object') {
    if ('not' in condition) {
      return !evaluateCondition(value, condition.not);
    }
    for (const cmp of COMPARATORS) {
      if (cmp in condition) {
        const operand = Number(value);
        const bound = Number(condition[cmp]);
        if (Number.isNaN(operand) || Number.isNaN(bound)) {
          return false;
        }
        if (cmp === 'gt') {
          return operand > bound;
        }
        if (cmp === 'gte') {
          return operand >= bound;
        }
        if (cmp === 'lt') {
          return operand < bound;
        }
        return operand <= bound;
      }
    }
    return false;
  }
  return looseEqual(value, condition);
};

/**
 * Evaluate a show_if map against a context. Map = AND of its conditions;
 * the `any` key ORs a list of condition maps (each map itself an AND).
 * @param {Object} showIf - show_if map (closed grammar)
 * @param {Object} ctx - Operand values (answers+defaults+role flags)
 * @returns {boolean} Whether the field/group shows
 */
export const evaluateShowIf = (showIf, ctx) => {
  if (!showIf || typeof showIf !== 'object') {
    return true;
  }
  for (const [key, condition] of Object.entries(showIf)) {
    if (key === 'any') {
      if (!Array.isArray(condition) || !condition.some(map => evaluateShowIf(map, ctx))) {
        return false;
      }
      continue;
    }
    if (!evaluateCondition(ctx[key], condition)) {
      return false;
    }
  }
  return true;
};

/**
 * Compute the visible field set and the effective value map. Order (§3.1):
 * defaults merge FIRST, answers overlay, role flags join the context; group
 * visibility evaluates against the full merged context; fields evaluate in
 * DECLARATION ORDER with each hidden field's name REMOVED from the context
 * as it hides — a hidden field's answer is never collected and its name is
 * ABSENT from the render context.
 * @param {Object} configuration - metadata.configuration {groups, fields}
 * @param {Object} answers - Flat user answer map
 * @param {Object} roleFlags - Role-enable flags (`<role name>_enabled` spelling)
 * @returns {{values: Object, hidden: string[], visibleFields: Object[]}}
 */
export const computeVisibility = (configuration, answers = {}, roleFlags = {}) => {
  const groups = Array.isArray(configuration?.groups) ? configuration.groups : [];
  const fields = Array.isArray(configuration?.fields) ? configuration.fields : [];

  const values = {};
  for (const field of fields) {
    if (field && typeof field.name === 'string' && field.default !== undefined) {
      values[field.name] = field.default;
    }
  }
  for (const [key, value] of Object.entries(answers || {})) {
    values[key] = value;
  }

  const ctx = { ...roleFlags, ...values };
  const groupVisible = {};
  for (const group of groups) {
    if (group && typeof group.name === 'string') {
      groupVisible[group.name] = group.show_if ? evaluateShowIf(group.show_if, ctx) : true;
    }
  }

  const hidden = [];
  const visibleFields = [];
  for (const field of fields) {
    if (!field || typeof field.name !== 'string') {
      continue;
    }
    const inVisibleGroup = field.group ? groupVisible[field.group] !== false : true;
    const shows = inVisibleGroup && (field.show_if ? evaluateShowIf(field.show_if, ctx) : true);
    if (shows) {
      visibleFields.push(field);
    } else {
      hidden.push(field.name);
      delete ctx[field.name];
      delete values[field.name];
    }
  }

  return { values, hidden, visibleFields };
};

/**
 * Type check for the option-carrying types (select/multiselect).
 * @param {Object} field - Field definition
 * @param {*} value - Effective value
 * @returns {string|null} Error message
 */
const optionTypeError = (field, value) => {
  if (field.type === 'multiselect') {
    if (!Array.isArray(value)) {
      return 'must be a list';
    }
    if (Array.isArray(field.options)) {
      const legal = field.options.map(optionValue);
      const bad = value.find(entry => !legal.includes(entry));
      return bad === undefined ? null : `"${bad}" is not one of the options`;
    }
    return null;
  }
  if (Array.isArray(field.options) && !field.options.map(optionValue).includes(value)) {
    return `"${value}" is not one of the options`;
  }
  return typeof value === 'string' || typeof value === 'number' ? null : 'must be a scalar';
};

/**
 * Format checks for the string-shaped types (fqdn/ipaddr/cidr; the rest
 * only need the string check itself).
 * @param {Object} field - Field definition
 * @param {string} value - Effective value (already a string)
 * @returns {string|null} Error message
 */
const stringTypeError = (field, value) => {
  if (field.type === 'fqdn' && !FQDN_PATTERN.test(value)) {
    return 'must be a fully-qualified domain name';
  }
  if (field.type === 'ipaddr') {
    const version = net.isIP(value);
    if (version === 0) {
      return 'must be an IP address';
    }
    if (field.version && version !== Number(field.version)) {
      return `must be an IPv${field.version} address`;
    }
  }
  if (field.type === 'cidr') {
    const [addr, prefix, extra] = value.split('/');
    const version = net.isIP(addr || '');
    const bits = Number(prefix);
    const cap = version === 6 ? 128 : 32;
    if (extra !== undefined || version === 0 || !Number.isInteger(bits) || bits < 0 || bits > cap) {
      return 'must be CIDR notation (address/prefix)';
    }
  }
  return null;
};

/**
 * Validate one visible field's value against its type. Returns a message or
 * null. Absent values are the caller's `required` concern, not a type error.
 * @param {Object} field - Field definition
 * @param {*} value - Effective value
 * @returns {string|null} Error message
 */
const typeError = (field, value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (field.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
  }
  if (field.type === 'checkbox') {
    return typeof value === 'boolean' ? null : 'must be true or false';
  }
  if (field.type === 'select' || field.type === 'multiselect') {
    return optionTypeError(field, value);
  }
  if (!STRING_TYPES.includes(field.type)) {
    return null;
  }
  if (typeof value !== 'string') {
    return 'must be a string';
  }
  return stringTypeError(field, value);
};

/**
 * Apply a visible field's validate block (§3.1 closed set). Returns a
 * message or null.
 * @param {Object} field - Field definition
 * @param {*} value - Effective value
 * @returns {string|null} Error message
 */
const validateRuleError = (field, value) => {
  const rules = field.validate;
  if (!rules || value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    if (rules.min !== undefined && value < rules.min) {
      return `must be at least ${rules.min}`;
    }
    if (rules.max !== undefined && value > rules.max) {
      return `must be at most ${rules.max}`;
    }
  }
  if (typeof value === 'string') {
    if (rules.min_length !== undefined && value.length < rules.min_length) {
      return `must be at least ${rules.min_length} characters`;
    }
    if (rules.max_length !== undefined && value.length > rules.max_length) {
      return `must be at most ${rules.max_length} characters`;
    }
    if (rules.pattern !== undefined && !new RegExp(rules.pattern, 'u').test(value)) {
      // pattern_error is REQUIRED beside pattern (import lint enforces it)
      return rules.pattern_error || 'does not match the required pattern';
    }
  }
  return null;
};

const isEmpty = value =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);

/**
 * AUTHORITATIVE pre-render answer validation (§3.1): defaults merge before
 * conditionals, `required` enforced only while visible, hidden answers
 * stripped (never collected), unknown answer keys refused, `immutable`
 * refuses changes after the first successful provision. Backs the 422
 * {FIELD: message} wire.
 * @param {Object} configuration - metadata.configuration {groups, fields}
 * @param {Object} answers - Flat user answer map (exact field names)
 * @param {Object} roleFlags - Role-enable flags for show_if operands
 * @param {Object} [opts] - { previousAnswers, provisioned } for immutable
 * @returns {{errors: Object, values: Object, hidden: string[]}} errors keyed
 *   by FIELD name (empty object = valid); values = effective visible values
 */
export const validateAnswers = (configuration, answers = {}, roleFlags = {}, opts = {}) => {
  const errors = {};
  const fields = Array.isArray(configuration?.fields) ? configuration.fields : [];
  const byName = new Map(fields.filter(f => f && f.name).map(f => [f.name, f]));

  for (const key of Object.keys(answers || {})) {
    if (!byName.has(key)) {
      errors[key] = 'is not a declared field';
    }
  }

  const { values, hidden, visibleFields } = computeVisibility(configuration, answers, roleFlags);

  for (const field of visibleFields) {
    const value = values[field.name];
    if (field.required === true && isEmpty(value)) {
      errors[field.name] = 'is required';
      continue;
    }
    const message = typeError(field, value) || validateRuleError(field, value);
    if (message) {
      errors[field.name] = message;
    }
    if (
      field.immutable === true &&
      opts.provisioned === true &&
      opts.previousAnswers &&
      field.name in opts.previousAnswers &&
      value !== opts.previousAnswers[field.name]
    ) {
      errors[field.name] = 'is immutable after the first provision';
    }
  }

  return { errors, values, hidden };
};
