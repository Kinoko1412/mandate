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

/** 安裝一次性的 WebAssembly.compile patch。Node 環境下這個 patch 幾乎不會真的介入
 *（原生呼叫直接成功），只有在真的遇到 Workers 限制時才會查表 fallback。 */
function installWorkersWasmCompat() {
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
