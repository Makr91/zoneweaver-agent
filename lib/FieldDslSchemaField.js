import { optionValue } from './FieldDsl.js';

export const schemaForField = field => {
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
