'use strict';

const schema = require('./schema-v1.json');

function resolveRef(ref) {
  const prefix = '#/definitions/';
  if (typeof ref !== 'string' || !ref.startsWith(prefix)) {
    throw new Error(`不支援的 schema $ref：${ref}`);
  }
  const definition = schema.definitions[ref.slice(prefix.length)];
  if (!definition) throw new Error(`找不到 schema definition：${ref}`);
  return definition;
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateNode(value, rawRule, path, errors) {
  const rule = rawRule.$ref ? resolveRef(rawRule.$ref) : rawRule;
  if (rule.type) {
    const allowedTypes = Array.isArray(rule.type) ? rule.type : [rule.type];
    if (!allowedTypes.some((type) => matchesType(value, type))) {
      errors.push({ path, keyword: 'type', message: `應為 ${allowedTypes.join(' 或 ')}` });
      return;
    }
  }

  if (rule.enum && !rule.enum.includes(value)) {
    errors.push({ path, keyword: 'enum', message: `不在允許值 ${rule.enum.join(', ')} 中` });
  }
  if (typeof value === 'number' && rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum) {
    errors.push({ path, keyword: 'exclusiveMinimum', message: `必須大於 ${rule.exclusiveMinimum}` });
  }

  if (matchesType(value, 'object')) {
    for (const key of rule.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push({ path: `${path}.${key}`, keyword: 'required', message: '缺少必填欄位' });
      }
    }
    for (const [key, propertyRule] of Object.entries(rule.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateNode(value[key], propertyRule, `${path}.${key}`, errors);
      }
    }
  }

  if (Array.isArray(value) && rule.items) {
    value.forEach((item, index) => validateNode(item, rule.items, `${path}[${index}]`, errors));
  }
}

function validateCanonical(entityName, value) {
  const definition = schema.definitions[entityName];
  if (!definition || definition.type !== 'object') {
    throw new Error(`未知 canonical entity：${entityName}`);
  }
  const errors = [];
  validateNode(value, definition, entityName, errors);
  return { valid: errors.length === 0, errors };
}

module.exports = {
  schema,
  validateCanonical,
};
