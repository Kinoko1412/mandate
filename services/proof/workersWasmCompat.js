'use strict';

/**
 * services/proof/workersWasmCompat — Cloudflare Workers 相容層。
 *
 * 背景（步驟 0 相容性 spike 的結論，見 circuits/README.md）：snarkjs／ffjavascript／
 * circom_runtime 內部都會在執行期呼叫 `WebAssembly.compile(bytes)` 動態編譯它們自己
 * 產生／讀到的 wasm bytes。這在一般 Node 完全沒問題，但 Cloudflare Workers runtime
 * （workerd）基於安全考量禁止「執行期動態產生的程式碼」，直接丟出
 * `CompileError: Wasm code generation disallowed by embedder`。
 *
 * Workers 允許的路徑是「build-time 靜態 `.wasm` import → 拿到 WebAssembly.Module →
 * 執行期只做 WebAssembly.instantiate(module, importObject)」。這個模組把
 * `WebAssembly.compile`包一層：Node 環境下原生呼叫直接成功、什麼都不用做；Workers
 * 環境下原生呼叫丟出上述特定錯誤時，用輸入 bytes 的 SHA-256 指紋比對一份「離線
 * 預先編譯好、透過 worker/index.js 靜態 import 進來」的 Module 白名單，比對到就回傳
 * 那顆 Module，比對不到就誠實丟出錯誤（不會靜默用錯的 wasm 蒙混過關）。
 *
 * 呼叫端（worker/index.js）要在應用程式邏輯執行之前，把每一份靜態 import 到的
 * WebAssembly.Module 連同它的原始 bytes 指紋一起呼叫 registerPrebuiltWasm() 登記。
 * 一般 Node 環境（server/index.js）完全不需要呼叫這個模組，原生 compile 就會成功。
 *
 * 2026-08-26 追加（部署後才真的踩到，且真的修好、部署驗證過）：snarkjs 自己的 bundle
 * 在 `import('snarkjs')` 模組頂層執行時就會呼叫一次 `URL.createObjectURL`（跟多執行緒
 * worker 支援有關，Workers runtime 單執行緒環境用不到），workerd **有定義**這個方法但
 * 呼叫下去直接丟 `URL.createObjectURL() is not implemented`。這個錯誤比
 * WebAssembly.compile 那個還早發生，在 import 階段就炸了，wasm compile fallback 完全
 * 還沒機會介入。`circuits/workers-compat-check/`（步驟 0 相容性 spike）當時就發現並
 * 繞過了這個問題，但 fix 只留在 spike 專案裡，從來沒搬進正式的
 * `services/proof/zk.js`／`worker/index.js`——因為在那之前，
 * `generateRealZkProof`/`verifyRealZkProof` 從來沒有被正式的即時流程真的呼叫過，這個
 * bug 一直是潛伏的，直到 Day 5 追加③把真電路接進 trustAdapter.js 的
 * productionEvaluator、部署到 Cloudflare 才真的爆出來。
 *
 * **修的過程踩到第二層坑**：第一版判斷式寫 `if (typeof URL.createObjectURL ===
 * 'function') return;`，部署後檢查發現完全沒用——因為 workerd 的 `URL.createObjectURL`
 * **本來就是一個函式**（只是呼叫下去會丟錯誤），`typeof` 檢查永遠是 `'function'`、
 * 永遠提早 return、根本沒真的 patch 到。改成真的呼叫一次（傳一個小 Blob 進去）包
 * try/catch，才能分辨「這個方法真的能用」跟「這個方法存在但一呼叫就丟錯誤」。修好後
 * 部署到 `mandate.david460525.workers.dev` 重跑 3 次完整 E2E（reset→上傳→確認→提交→
 * revalidate），`real_zk_proof` 全部 pass，`READY_FOR_VERIFIER`，全程 <1.6 秒，
 * 不是理論上修好、是真的在 Cloudflare Workers 上驗證過。
 */

const registry = [];
let patched = false;

function bufferSourceToUint8Array(bufferSource) {
  if (bufferSource instanceof Uint8Array) return bufferSource;
  if (bufferSource instanceof ArrayBuffer) return new Uint8Array(bufferSource);
  // WebAssembly.compile 允許任何 BufferSource（TypedArray 或 ArrayBuffer）。
  return new Uint8Array(bufferSource.buffer, bufferSource.byteOffset, bufferSource.byteLength);
}

function bufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

async function sha256Hex(uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', uint8Array);
  return bufferToHex(digest);
}

/** 登記一份離線預先編譯好的 WebAssembly.Module，供 Workers 環境下的 compile fallback 比對用。 */
function registerPrebuiltWasm(fingerprintHex, wasmModule) {
  registry.push({ fingerprintHex, wasmModule });
}

function isWorkersCompileRestriction(err) {
  const message = (err && err.message) || String(err);
  return /disallowed by embedder|Wasm code generation/i.test(message);
}

/** workerd **有定義** URL.createObjectURL（`typeof` 檢查會過），但實際呼叫會丟
 * `URL.createObjectURL() is not implemented`——不是「沒有這個方法」，是「這個方法存在
 * 但故意丟錯誤」，單純檢查 `typeof === 'function'` 完全抓不到這種情況（第一版這樣寫，
 * 部署後才發現這個檢查永遠通過、根本沒真的 patch 到）。這裡改成真的呼叫一次、包
 * try/catch 才能分辨「真的能用」跟「存在但會丟錯誤」。Node 環境原生實作是真的能用的，
 * 這個測試呼叫會成功、直接 return，不會覆蓋掉原生實作。 */
function installWorkersUrlCompat() {
  try {
    const testUrl = URL.createObjectURL(new Blob(['x']));
    URL.revokeObjectURL(testUrl);
    return; // 真的能用，不用 patch
  } catch {
    // 存在但會丟錯誤（workerd 這種情況），落到下面的 stub。
  }
  URL.createObjectURL = () => 'blob:workers-compat-stub';
  URL.revokeObjectURL = () => {};
}

/** 安裝一次性的 WebAssembly.compile patch（以及上面的 URL stub）。Node 環境下這些
 * patch 幾乎不會真的介入（原生呼叫/實作直接可用），只有在真的遇到 Workers 限制時
 * 才會查表 fallback 或用 stub。 */
function installWorkersWasmCompat() {
  installWorkersUrlCompat();
  if (patched) return;
  patched = true;
  const nativeCompile = WebAssembly.compile.bind(WebAssembly);
  WebAssembly.compile = async (bufferSource) => {
    try {
      return await nativeCompile(bufferSource);
    } catch (err) {
      if (!isWorkersCompileRestriction(err)) throw err;
      const bytes = bufferSourceToUint8Array(bufferSource);
      const fingerprintHex = await sha256Hex(bytes);
      const hit = registry.find((entry) => entry.fingerprintHex === fingerprintHex);
      if (!hit) {
        throw new Error(
          `[workersWasmCompat] WebAssembly.compile 被 Workers runtime 擋下，且沒有登記過對應的 ` +
            `離線預編譯 fallback（bytes fingerprint=${fingerprintHex}，長度=${bytes.length}）。這代表 ` +
            `出現了一個新的、還沒被 worker/index.js 靜態 import 並 registerPrebuiltWasm() 登記過的 ` +
            `wasm 來源——不會用錯的 module 蒙混過關，需要先補上對應的離線預編譯 + 登記。原始錯誤：${err.message}`
        );
      }
      return hit.wasmModule;
    }
  };
}

module.exports = {
  registerPrebuiltWasm,
  installWorkersWasmCompat,
  isWorkersCompileRestriction,
  sha256Hex,
  bufferSourceToUint8Array,
  _resetRegistryForTests() {
    registry.length = 0;
  },
};
