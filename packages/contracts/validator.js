'use strict';

/**
 * packages/contracts/validator.js — canonical schema-v1.json 的執行期驗證器。
 *
 * Day 5：從手寫的最小 JSON Schema 子集驗證器換成用 ajv（真正的 JSON Schema draft-07
 * 驗證器）編譯 schema-v1.json 本身，執行期驗證是真的照 schema 逐條規則跑。
 *
 * Day 5 追加（2026-08-26 部署才發現）：ajv 在執行期呼叫 `new Function()` 產生驗證函式，
 * 部署到 Cloudflare Workers 時直接炸掉——`EvalError: Code generation from strings
 * disallowed for this context`。查證過 Cloudflare **完全沒有**任何 compatibility flag
 * 能開放 unsafe-eval（不是還沒找到設定方式，是這個平台的硬限制），社群/官方 issue 一致
 * 建議的解法是離線預編譯——跟今晚稍早 ZK 電路 wasm 離線預編譯是同一種策略：不在執行期
 * 動態編譯，改成 build-time 產生靜態 JS 產物、直接 require()。
 *
 * 實際做法：`packages/contracts/buildValidators.js`（手動執行，改 schema-v1.json 後要
 * 重跑）用 ajv 官方支援的 "standalone code" 模式，把每個 canonical entity 的驗證函式
 * 編譯成純 JS 原始碼，輸出到 `compiledValidators.js`（已檢查過，裡面完全沒有
 * `new Function`，Node/Workers 都能直接 require()）。這裡只是 require 那份靜態產物，
 * 不再持有 Ajv instance。對外介面完全不變（`validateCanonical(entityName, value) ->
 * {valid, errors}`），呼叫端（agentAdapter.js、services/proof、tests/ 全部套件）
 * 不用改一行。
 */

const schema = require('./schema-v1.json');
const compiledValidators = require('./compiledValidators');

function getValidator(entityName) {
  const definition = schema.definitions[entityName];
  if (!definition || definition.type !== 'object') {
    throw new Error(`未知 canonical entity：${entityName}`);
  }
  const validate = compiledValidators[entityName];
  if (!validate) {
    throw new Error(
      `compiledValidators.js 沒有 ${entityName} 的預編譯驗證函式——如果剛改過 ` +
        `schema-v1.json，記得重跑 node packages/contracts/buildValidators.js。`
    );
  }
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
