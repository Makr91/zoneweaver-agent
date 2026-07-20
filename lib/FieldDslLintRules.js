import { STRING_TYPES, OPTIONS_SOURCES } from './FieldDsl.js';

const VALIDATE_KEYS = ['min', 'max', 'min_length', 'max_length', 'pattern', 'pattern_error'];
const COMPARATORS = ['gt', 'gte', 'lt', 'lte'];

/** Regex features outside the JS/Go-common subset (Go RE2 has neither). */
const NON_PORTABLE_REGEX = /\(\?<?[=!]|\\[1-9]/u;

/**
 * Lint one show_if map (closed grammar §3.1): map = AND; scalar → equals;
 * [list] → IN; {not:}; {gt|gte|lt|lte: number}; any: [maps] → OR (one
 * level). Operands must be earlier-declared fields or role-enable flags.
 * @param {*} showIf - The show_if value
 * @param {string} path - Error path prefix
 * @param {Set<string>} operands - Legal operand names at this point
 * @param {Array} errors - Error collector
 */
export const lintShowIf = (showIf, path, operands, errors) => {
  if (!showIf || typeof showIf !== 'object' || Array.isArray(showIf)) {
    errors.push({ path, message: 'show_if must be a map of conditions', node: showIf });
    return;
  }
  for (const [key, condition] of Object.entries(showIf)) {
    if (key === 'any') {
      if (!Array.isArray(condition) || condition.length === 0) {
        errors.push({
          path: `${path}.any`,
          message: 'any takes a list of condition maps',
          node: condition,
        });
        continue;
      }
      condition.forEach((map, i) => {
        if (!map || typeof map !== 'object' || Array.isArray(map) || 'any' in map) {
          errors.push({
            path: `${path}.any[${i}]`,
            message: 'any entries are plain condition maps (no nested any)',
            node: map,
          });
        } else {
          lintShowIf(map, `${path}.any[${i}]`, operands, errors);
        }
      });
      continue;
    }
    if (!operands.has(key)) {
      errors.push({
        path: `${path}.${key}`,
        message: 'operand is not an earlier-declared field or role-enable flag',
        node: condition,
      });
    }
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      const keys = Object.keys(condition);
      const legal = keys.length === 1 && (keys[0] === 'not' || COMPARATORS.includes(keys[0]));
      if (!legal) {
        errors.push({
          path: `${path}.${key}`,
          message: 'condition object must be exactly one of {not}, {gt}, {gte}, {lt}, {lte}',
          node: condition,
        });
      } else if (COMPARATORS.includes(keys[0]) && typeof condition[keys[0]] !== 'number') {
        errors.push({
          path: `${path}.${key}.${keys[0]}`,
          message: 'comparator bound must be a number',
          node: condition,
        });
      }
    }
  }
};

/**
 * Lint one field's validate block against its type (§3.1 closed set;
 * pattern REQUIRES pattern_error; regex must stay in the JS/Go-common
 * subset).
 * @param {Object} field - Field definition
 * @param {string} path - Error path prefix
 * @param {Array} errors - Error collector
 */
export const lintValidate = (field, path, errors) => {
  const rules = field.validate;
  if (rules === undefined) {
    return;
  }
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
    errors.push({ path, message: 'validate must be a map', node: rules });
    return;
  }
  for (const key of Object.keys(rules)) {
    if (!VALIDATE_KEYS.includes(key)) {
      errors.push({ path: `${path}.${key}`, message: 'unknown validate rule', node: rules[key] });
    }
  }
  const numeric = field.type === 'number';
  if ((rules.min !== undefined || rules.max !== undefined) && !numeric) {
    errors.push({ path, message: 'min/max apply to number fields only', node: rules });
  }
  const stringy = STRING_TYPES.includes(field.type);
  if (
    (rules.min_length !== undefined ||
      rules.max_length !== undefined ||
      rules.pattern !== undefined) &&
    !stringy
  ) {
    errors.push({
      path,
      message: 'min_length/max_length/pattern apply to string fields only',
      node: rules,
    });
  }
  if (rules.pattern !== undefined) {
    if (typeof rules.pattern_error !== 'string' || rules.pattern_error === '') {
      errors.push({
        path: `${path}.pattern_error`,
        message: 'pattern REQUIRES pattern_error',
        node: rules,
      });
    }
    try {
      RegExp(rules.pattern, 'u');
    } catch (regexError) {
      errors.push({
        path: `${path}.pattern`,
        message: `invalid regex: ${regexError.message}`,
        node: rules.pattern,
      });
    }
    if (NON_PORTABLE_REGEX.test(String(rules.pattern))) {
      errors.push({
        path: `${path}.pattern`,
        message: 'lookaround/backreferences are outside the JS/Go-common regex subset',
        node: rules.pattern,
      });
    }
  }
};

/**
 * Lint the scalar type-specific keys: textarea's rows, ipaddr's version.
 * @param {Object} field - Field definition
 * @param {string} path - Error path prefix
 * @param {Array} errors - Error collector
 */
const lintScalarTypeKeys = (field, path, errors) => {
  if (field.rows !== undefined && field.type !== 'textarea') {
    errors.push({
      path: `${path}.rows`,
      message: 'rows applies to textarea only',
      node: field.rows,
    });
  }
  if (field.rows !== undefined && (!Number.isInteger(field.rows) || field.rows < 1)) {
    errors.push({
      path: `${path}.rows`,
      message: 'rows must be a positive integer',
      node: field.rows,
    });
  }
  if (field.version !== undefined && field.type !== 'ipaddr') {
    errors.push({
      path: `${path}.version`,
      message: 'version applies to ipaddr only',
      node: field.version,
    });
  }
  if (field.version !== undefined && ![4, 6].includes(Number(field.version))) {
    errors.push({
      path: `${path}.version`,
      message: 'version must be 4 or 6',
      node: field.version,
    });
  }
};

/**
 * Lint select/multiselect's options keys (options XOR options_source,
 * entry shapes, legal sources).
 * @param {Object} field - Field definition
 * @param {string} path - Error path prefix
 * @param {Array} errors - Error collector
 */
const lintSelectKeys = (field, path, errors) => {
  const selectish = field.type === 'select' || field.type === 'multiselect';
  if ((field.options !== undefined || field.options_source !== undefined) && !selectish) {
    errors.push({
      path,
      message: 'options/options_source apply to select and multiselect only',
      node: field.type,
    });
  }
  if (!selectish) {
    return;
  }
  if (field.options !== undefined && field.options_source !== undefined) {
    errors.push({
      path,
      message: 'options and options_source are mutually exclusive',
      node: field.name,
    });
  }
  if (field.options === undefined && field.options_source === undefined) {
    errors.push({
      path,
      message: `${field.type} needs options or options_source`,
      node: field.name,
    });
  }
  if (field.options !== undefined && !Array.isArray(field.options)) {
    errors.push({
      path: `${path}.options`,
      message: 'options must be a list',
      node: field.options,
    });
  }
  if (Array.isArray(field.options)) {
    field.options.forEach((option, i) => {
      const object = option && typeof option === 'object';
      if (object && (option.value === undefined || typeof option.label !== 'string')) {
        errors.push({
          path: `${path}.options[${i}]`,
          message: 'object options carry value and label',
          node: option,
        });
      }
    });
  }
  if (field.options_source !== undefined && !OPTIONS_SOURCES.includes(field.options_source)) {
    errors.push({
      path: `${path}.options_source`,
      message: `options_source must be one of ${OPTIONS_SOURCES.join('|')}`,
      node: field.options_source,
    });
  }
};

/**
 * Lint password's keys: no default ever, generate = {length: positive int},
 * generate on password only.
 * @param {Object} field - Field definition
 * @param {string} path - Error path prefix
 * @param {Array} errors - Error collector
 */
const lintPasswordKeys = (field, path, errors) => {
  if (field.type !== 'password') {
    if (field.generate !== undefined) {
      errors.push({
        path: `${path}.generate`,
        message: 'generate applies to password only',
        node: field.generate,
      });
    }
    return;
  }
  if (field.default !== undefined) {
    errors.push({
      path: `${path}.default`,
      message: 'password fields never carry a default',
      node: field.name,
    });
  }
  if (field.generate !== undefined) {
    const length = field.generate?.length;
    if (
      !field.generate ||
      typeof field.generate !== 'object' ||
      !Number.isInteger(length) ||
      length < 1
    ) {
      errors.push({
        path: `${path}.generate`,
        message: 'generate takes {length: positive integer}',
        node: field.generate,
      });
    }
  }
};

/**
 * Lint one field's type-specific keys (rows/options/options_source/version/
 * generate) and password's no-default rule.
 * @param {Object} field - Field definition
 * @param {string} path - Error path prefix
 * @param {Array} errors - Error collector
 */
export const lintFieldTypeKeys = (field, path, errors) => {
  lintScalarTypeKeys(field, path, errors);
  lintSelectKeys(field, path, errors);
  lintPasswordKeys(field, path, errors);
};
