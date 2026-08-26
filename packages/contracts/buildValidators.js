'use strict';

/**
 * packages/contracts/buildValidators.js — 離線預編譯 ajv 驗證函式，避免 Cloudflare Workers
 * 執行期呼叫 `new Function()`（ajv.compile() 內部用來產生快速驗證函式的機制）。
 *
 * 背景：`validator.js` 原本在 Workers 上部署時直接炸掉——
 * `EvalError: Code generation from strings disallowed for this context`，來自 ajv 的
 * compileSchema 呼叫 `new Function(...)`。Cloudflare Workers **沒有**任何 compatibility
 * flag 能開放 unsafe-eval（查證過，不是猜的，見 packages/contracts/README.md 的完整
 * 技術說明與來源），唯一可靠的解法是離線把驗證函式編譯成純 JS 原始碼（ajv 官方支援的
 * "standalone code" 模式），跟今晚稍早 ZK 電路 wasm 離線預編譯是同一種策略：不在執行期
 * 做動態編譯，改成 build-time 產生靜態產物、直接 require()。
 *
 * 這支腳本手動執行一次（`node packages/contracts/buildValidators.js`），輸出
 * `packages/contracts/compiledValidators.js`（純 JS，Node/Workers 都能直接 require()，
 * 不呼叫 new Function）。**改了 schema-v1.json 之後要重新跑這支腳本**，不是自動觸發。
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const standaloneCode = require('ajv/dist/standalone').default;
const schema = require('./schema-v1.json');

const ajv = new Ajv({ allErrors: true, strict: false, code: { source: true, esm: false } });
addFormats(ajv);

const entityNames = Object.keys(schema.definitions);
for (const [name, definition] of Object.entries(schema.definitions)) {
  ajv.addSchema({ ...definition, $id: `#/definitions/${name}` }, `#/definitions/${name}`);
}

// standaloneCode 第二參數：{ 匯出名稱: schema $id }，讓產生的模組把每個 entity 的驗證函式
//各自匯出成一個具名 export，呼叫端用 `require('./compiledValidators')[entityName]` 取用。
const exportsMap = Object.fromEntries(entityNames.map((name) => [name, `#/definitions/${name}`]));
const moduleCode = standaloneCode(ajv, exportsMap);

const outPath = path.join(__dirname, 'compiledValidators.js');
fs.writeFileSync(outPath, moduleCode, 'utf8');
console.log(`已產生 ${outPath}（${entityNames.length} 個 entity：${entityNames.join('、')}）`);
