/**
 * @fileoverview Field DSL — import-time lint + schema.json derivation
 * (provisioning-design §3.1)
 * @description Fail-closed schema lint for `metadata.configuration` — unknown
 * types/keys are import ERRORS, the refusal echoes the author's YAML with
 * inline annotations. Also derives the cached JSON Schema (2020-12) written
 * beside role-specs.yml at import. Runtime evaluation lives in FieldDsl.js.
 */

import yaml from 'js-yaml';
import { FIELD_TYPES, STRING_TYPES, OPTIONS_SOURCES, optionValue } from './FieldDsl.js';

const GROUP_KEYS = ['name', 'label', 'help', 'advanced', 'show_if'];
const FIELD_KEYS = [
  'name',
  'type',
  'label',
  'help',
  'group',
  'default',
  'required',
  'immutable',
  'show_if',
  'validate',
  'options',
  'options_source',
  'rows',
  'version',
  'generate',
];
const VALIDATE_KEYS = ['min', 'max', 'min_length', 'max_length', 'pattern', 'pattern_error'];
const COMPARATORS = ['gt', 'gte', 'lt', 'lte'];

/** Field names are EXACT Jinja2 context keys (§3.1). */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

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
const lintShowIf = (showIf, path, operands, errors) => {
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
const lintValidate = (field, path, errors) => {
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
const lintFieldTypeKeys = (field, path, errors) => {
  lintScalarTypeKeys(field, path, errors);
  lintSelectKeys(field, path, errors);
  lintPasswordKeys(field, path, errors);
};

/**
 * Lint a manifest's `metadata.configuration` (§3.1, fail-closed). The old
 * basicFields/advancedFields shape is a ONE-CUT error, never silently
 * ignored. Role flags join the legal show_if operands in the ruled contract
 * spelling ONLY: `<metadata.roles[].name>_enabled`, verbatim.
 * @param {Object} configuration - metadata.configuration
 * @param {Array} [roles] - metadata.roles entries ({name})
 * @returns {Array<{path: string, message: string, node: *}>} errors (empty = valid)
 */
export const lintConfiguration = (configuration, roles = []) => {
  const errors = [];
  if (configuration === undefined || configuration === null) {
    return errors;
  }
  if (typeof configuration !== 'object' || Array.isArray(configuration)) {
    errors.push({
      path: 'configuration',
      message: 'configuration must be a map',
      node: configuration,
    });
    return errors;
  }
  for (const legacy of ['basicFields', 'advancedFields']) {
    if (legacy in configuration) {
      errors.push({
        path: `configuration.${legacy}`,
        message:
          'basicFields/advancedFields are replaced by {groups, fields} — one cut, convert the manifest',
        node: configuration[legacy],
      });
    }
  }
  for (const key of Object.keys(configuration)) {
    if (!['groups', 'fields', 'basicFields', 'advancedFields'].includes(key)) {
      errors.push({
        path: `configuration.${key}`,
        message: 'unknown configuration key',
        node: configuration[key],
      });
    }
  }

  // Role-flag operands: the ruled contract spelling ONLY —
  // `<metadata.roles[].name>_enabled`, the manifest name VERBATIM.
  const operands = new Set();
  for (const role of Array.isArray(roles) ? roles : []) {
    if (role && typeof role.name === 'string') {
      operands.add(`${role.name}_enabled`);
    }
  }

  const groups = configuration.groups === undefined ? [] : configuration.groups;
  const fields = configuration.fields === undefined ? [] : configuration.fields;
  if (!Array.isArray(groups)) {
    errors.push({ path: 'configuration.groups', message: 'groups must be a list', node: groups });
  }
  if (!Array.isArray(fields)) {
    errors.push({ path: 'configuration.fields', message: 'fields must be a list', node: fields });
    return errors;
  }

  const groupNames = new Set();
  (Array.isArray(groups) ? groups : []).forEach((group, i) => {
    const path = `configuration.groups[${i}]`;
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      errors.push({ path, message: 'group must be a map', node: group });
      return;
    }
    for (const key of Object.keys(group)) {
      if (!GROUP_KEYS.includes(key)) {
        errors.push({ path: `${path}.${key}`, message: 'unknown group key', node: group[key] });
      }
    }
    if (typeof group.name !== 'string' || group.name === '') {
      errors.push({ path: `${path}.name`, message: 'group name is required', node: group });
    } else if (groupNames.has(group.name)) {
      errors.push({
        path: `${path}.name`,
        message: `duplicate group name "${group.name}"`,
        node: group.name,
      });
    } else {
      groupNames.add(group.name);
    }
    if (group.advanced !== undefined && typeof group.advanced !== 'boolean') {
      errors.push({
        path: `${path}.advanced`,
        message: 'advanced must be a boolean',
        node: group.advanced,
      });
    }
    if (group.show_if !== undefined) {
      // Group operands: any declared field NOT inside the group + role flags
      const groupOperands = new Set(operands);
      for (const field of fields) {
        if (field && typeof field.name === 'string' && field.group !== group.name) {
          groupOperands.add(field.name);
        }
      }
      lintShowIf(group.show_if, `${path}.show_if`, groupOperands, errors);
    }
  });

  const seen = new Set();
  fields.forEach((field, i) => {
    const path = `configuration.fields[${i}]`;
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      errors.push({ path, message: 'field must be a map', node: field });
      return;
    }
    for (const key of Object.keys(field)) {
      if (!FIELD_KEYS.includes(key)) {
        errors.push({ path: `${path}.${key}`, message: 'unknown field key', node: field[key] });
      }
    }
    if (typeof field.name !== 'string' || !NAME_PATTERN.test(field.name)) {
      errors.push({
        path: `${path}.name`,
        message: 'name is required and must be a legal Jinja2 identifier',
        node: field.name,
      });
    } else if (seen.has(field.name)) {
      errors.push({
        path: `${path}.name`,
        message: `duplicate field name "${field.name}"`,
        node: field.name,
      });
    }
    if (!FIELD_TYPES.includes(field.type)) {
      errors.push({
        path: `${path}.type`,
        message: `unknown type "${field.type}" — legal types: ${FIELD_TYPES.join(', ')}`,
        node: field.type,
      });
      return;
    }
    if (field.group !== undefined && !groupNames.has(field.group)) {
      errors.push({
        path: `${path}.group`,
        message: `group "${field.group}" is not declared`,
        node: field.group,
      });
    }
    for (const flag of ['required', 'immutable']) {
      if (field[flag] !== undefined && typeof field[flag] !== 'boolean') {
        errors.push({
          path: `${path}.${flag}`,
          message: `${flag} must be a boolean`,
          node: field[flag],
        });
      }
    }
    if (field.show_if !== undefined) {
      // Field operands: EARLIER-declared fields + role flags (§3.1)
      lintShowIf(field.show_if, `${path}.show_if`, new Set([...operands, ...seen]), errors);
    }
    lintFieldTypeKeys(field, path, errors);
    lintValidate(field, path, errors);
    if (typeof field.name === 'string') {
      seen.add(field.name);
    }
  });

  return errors;
};

/**
 * Render lint errors as the import refusal: each error names its path and
 * echoes the offending node as YAML with an inline annotation (§3.1: the
 * refusal echoes the author's YAML).
 * @param {Array} errors - lintConfiguration output
 * @returns {string} Multi-line refusal message
 */
export const formatLintErrors = errors =>
  errors
    .map(({ path, message, node }) => {
      let echo = '';
      try {
        echo = yaml.dump(node === undefined ? null : node, { flowLevel: 2 }).trimEnd();
      } catch {
        echo = String(node);
      }
      const annotated = echo
        .split('\n')
        .slice(0, 6)
        .map(line => `    ${line}`)
        .join('\n');
      return `${path}: ${message}\n${annotated}\n    # ^ ERROR: ${message}`;
    })
    .join('\n');

const schemaForField = field => {
  const schema = {};
  if (typeof field.label === 'string') {
    schema.title = field.label;
  }
  if (typeof field.help === 'string') {
    schema.description = field.help;
  }
  if (field.default !== undefined) {
    schema.default = field.default;
  }
  if (field.type === 'number') {
    schema.type = 'number';
    if (field.validate?.min !== undefined) {
      schema.minimum = field.validate.min;
    }
    if (field.validate?.max !== undefined) {
      schema.maximum = field.validate.max;
    }
    return schema;
  }
  if (field.type === 'checkbox') {
    schema.type = 'boolean';
    return schema;
  }
  if (field.type === 'multiselect') {
    schema.type = 'array';
    schema.items = Array.isArray(field.options)
      ? { enum: field.options.map(optionValue) }
      : { type: 'string' };
    return schema;
  }
  if (field.type === 'select' && Array.isArray(field.options)) {
    schema.enum = field.options.map(optionValue);
    return schema;
  }
  schema.type = 'string';
  if (field.type === 'password') {
    schema.writeOnly = true;
  }
  if (field.type === 'fqdn') {
    schema.format = 'hostname';
  }
  if (field.type === 'ipaddr') {
    schema.format = Number(field.version) === 6 ? 'ipv6' : 'ipv4';
  }
  if (field.validate?.min_length !== undefined) {
    schema.minLength = field.validate.min_length;
  }
  if (field.validate?.max_length !== undefined) {
    schema.maxLength = field.validate.max_length;
  }
  if (field.validate?.pattern !== undefined) {
    schema.pattern = field.validate.pattern;
  }
  return schema;
};

/**
 * Derive the cached JSON Schema (2020-12) for a version's answers — written
 * beside role-specs.yml at import (§3.1 derived interop: API validation,
 * editor tooling, catalog embedding). Conditional visibility cannot ride
 * JSON Schema, so `required` lists only fields that are required AND
 * unconditionally visible (no show_if on the field or its group).
 * @param {Object} configuration - metadata.configuration {groups, fields}
 * @returns {Object} JSON Schema document
 */
export const deriveJsonSchema = configuration => {
  const fields = Array.isArray(configuration?.fields) ? configuration.fields : [];
  const groups = Array.isArray(configuration?.groups) ? configuration.groups : [];
  const conditionalGroups = new Set(
    groups.filter(g => g && g.show_if !== undefined).map(g => g.name)
  );

  const properties = {};
  const required = [];
  for (const field of fields) {
    if (!field || typeof field.name !== 'string' || !FIELD_TYPES.includes(field.type)) {
      continue;
    }
    properties[field.name] = schemaForField(field);
    const conditional = field.show_if !== undefined || conditionalGroups.has(field.group);
    if (field.required === true && !conditional) {
      required.push(field.name);
    }
  }

  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties,
  };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
};
