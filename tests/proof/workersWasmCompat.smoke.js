'use strict';

/**
 * tests/proof/workersWasmCompat.smoke.js — services/proof/workersWasmCompat.js 的
 * URL.createObjectURL 偵測邏輯。
 *
 * 背景：2026-08-26 部署到 Cloudflare Workers 時真的踩到這個 bug——workerd 的
 * `URL.createObjectURL` **本來就是一個函式**（只是呼叫下去會丟
 * `URL.createObjectURL() is not implemented`），第一版用 `typeof === 'function'` 判斷
 * 「要不要 patch」，這個檢查在 workerd 上永遠是 true、永遠提早 return、完全沒真的 patch
 * 到——本機 Node 環境測不出這個 bug（Node 原生 createObjectURL 真的能用，兩種判斷法在
 * Node 上結果一樣），只有真的部署到 Workers 才會爆。這裡用假造一個「存在但會丟錯誤」的
 * `URL.createObjectURL` 模擬 workerd 的行為，在 Node 環境也能測到同一種邏輯錯誤，不用
 * 每次改這段邏輯都要重新部署才知道對不對。
 */

const assert = require('assert');

let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${label}`);
    console.log(`      ${error.stack || error.message}`);
  }
}

/** 每次都用一份全新的 require cache，因為 installWorkersUrlCompat() 的效果
 * （patched 與否）是全域 URL 物件的副作用，不同測試案例之間不能互相汙染。 */
function freshModule() {
  const path = require.resolve('../../services/proof/workersWasmCompat.js');
  delete require.cache[path];
  return require('../../services/proof/workersWasmCompat.js');
}

async function main() {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;

  await check('模擬 workerd：createObjectURL 是函式、但呼叫下去會丟錯誤——修好之後的邏輯應該偵測到並真的 patch', async () => {
    URL.createObjectURL = () => {
      throw new Error('URL.createObjectURL() is not implemented');
    };
    URL.revokeObjectURL = () => {
      throw new Error('URL.revokeObjectURL() is not implemented');
    };
    try {
      const { installWorkersWasmCompat } = freshModule();
      installWorkersWasmCompat();
      // patch 完之後，呼叫 createObjectURL 不該再丟錯誤（換成 stub 版本）。
      const result = URL.createObjectURL(new Blob(['x']));
      assert.strictEqual(typeof result, 'string');
      assert.doesNotThrow(() => URL.revokeObjectURL(result));
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  await check('回歸測試：只檢查 typeof === "function" 絕對抓不到上面那種情況（證明舊邏輯錯在哪）', async () => {
    URL.createObjectURL = () => {
      throw new Error('URL.createObjectURL() is not implemented');
    };
    try {
      const looksLikeItWorks = typeof URL.createObjectURL === 'function';
      assert.strictEqual(looksLikeItWorks, true, '這正是舊邏輯會被騙過去的地方——typeof 檢查看起來沒問題，但呼叫下去其實會丟錯誤');
    } finally {
      URL.createObjectURL = originalCreate;
    }
  });

  await check('正常環境（Node 原生 createObjectURL 真的能用）：不應該被誤判、不應該被覆蓋掉', async () => {
    const { installWorkersWasmCompat } = freshModule();
    installWorkersWasmCompat();
    assert.strictEqual(URL.createObjectURL, originalCreate, 'Node 原生實作能正常運作時，不該被 stub 覆蓋掉');
  });

  console.log('');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
