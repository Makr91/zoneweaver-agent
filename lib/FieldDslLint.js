/**
 * @fileoverview Field DSL — import-time lint + schema.json derivation
 * (provisioning-design §3.1)
 * @description Fail-closed schema lint for `metadata.configuration` — unknown
 * types/keys are import ERRORS, the refusal echoes the author's YAML with
 * inline annotations. Also derives the cached JSON Schema (2020-12) written
 * beside role-specs.yml at import. Runtime evaluation lives in FieldDsl.js.
 */

import yaml from 'js-yaml';
import { FIELD_TYPES } from './FieldDsl.js';
import { lintShowIf, lintValidate, lintFieldTypeKeys } from './FieldDslLintRules.js';
import { schemaForField } from './FieldDslSchemaField.js';

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

/** Field names are EXACT Jinja2 context keys (§3.1). */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

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
