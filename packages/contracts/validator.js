'use strict';

/**
 * packages/contracts/validator.js — canonical schema-v1.json 的執行期驗證器。
 *
 * Day 5 前：這裡是一個手寫的最小 JSON Schema 子集驗證器（只認得 type/enum/
 * exclusiveMinimum/required/properties/items/$ref），功能上涵蓋了既有測試案例需要的
 * 檢查，但不是真的 JSON Schema draft-07 規格實作（例如完全沒檢查 additionalProperties、
 * pattern、format、minLength/maxLength 這類關鍵字，schema 裡寫了也不會真的被驗）。
 *
 * Day 5：換成用 ajv（真正的 JSON Schema draft-07 驗證器）編譯 schema-v1.json 本身，執行期
 * 驗證是真的照 schema 逐條規則跑，不是手寫邏輯的近似值。對外介面完全不變
 * （`validateCanonical(entityName, value) -> {valid, errors}`），呼叫端（agentAdapter.js、
 * services/proof、tests/ 全部套件）不用改一行。
 *
 * 驗證方式：把整份 schema-v1.json 的 `definitions` 一起交給 ajv（`addSchema` 用
 * `#/definitions/xxx` 當 $id 讓 $ref 能互相解析），對每個 canonical entity 各自編譯一支
 * validate function、cache 起來（compile 有成本，不要每次呼叫都重編）。
 */

const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const schema = require('./schema-v1.json');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// 把每個 definition 各自註冊成一份可以互相 $ref 的獨立 schema（$id 用
// `#/definitions/xxx`，剛好對應 schema-v1.json 本來就用的 $ref 慣例，不用改任何
// entity 定義本身的寫法）。
for (const [name, definition] of Object.entries(schema.definitions)) {
  ajv.addSchema({ ...definition, $id: `#/definitions/${name}` }, `#/definitions/${name}`);
}

const compiledValidators = new Map();

function getValidator(entityName) {
  if (compiledValidators.has(entityName)) return compiledValidators.get(entityName);
  const definition = schema.definitions[entityName];
  if (!definition || definition.type !== 'object') {
    throw new Error(`未知 canonical entity：${entityName}`);
  }
  const validate = ajv.getSchema(`#/definitions/${entityName}`);
  if (!validate) throw new Error(`ajv 找不到已編譯的 schema：${entityName}`);
  compiledValidators.set(entityName, validate);
  return validate;
}

function formatAjvErrors(ajvErrors) {
  return (ajvErrors || []).map((e) => ({
    path: e.instancePath ? e.instancePath.replace(/^\//, '').replace(/\//g, '.') : '(root)',
    keyword: e.keyword,
    message: e.message,
    params: e.params,
  }));
}

function validateCanonical(entityName, value) {
  const validate = getValidator(entityName);
  const valid = validate(value);
  return { valid: Boolean(valid), errors: valid ? [] : formatAjvErrors(validate.errors) };
}

module.exports = {
  schema,
  validateCanonical,
};
