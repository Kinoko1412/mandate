'use strict';

/**
 * services/proof/zk — 真正的 zk-SNARK（Circom + snarkjs groth16），取代 services/proof/index.js
 * 裡 `demoOnly` commitment 的「cryptographic_proof: skipped」那一格。
 *
 * 電路定義：circuits/carbon_proof.circom。命題（見 circuits/README.md 完整說明）：
 *   總碳足跡（totalScaled）= sum_i(quantityScaled[i] * factorScaled[i]) / SCALE，
 *   且 totalScaled <= complianceThresholdScaled。
 *   私密輸入：quantityScaled[4]（各製程階段排放分量）。
 *   公開輸入：factorScaled[4]、complianceThresholdScaled。
 *   公開輸出：totalScaled、compliant。
 *
 * 架構取捨（重要，README 也有記錄）：這個模組是**額外疊加**在 services/proof/index.js
 * 既有的 context-binding／nonce／replay-protection 邏輯之上的一層，不是取代它。原因：
 *   - services/proof/index.js 的 43 項既有測試（context mismatch／nonce 重放／SHIP-A
 *     套 SHIP-B 等）已經是真實可運作、經過驗證的防線，重寫成 ZK 電路的一部分風險高
 *     （電路只適合證明「純算術」，caseId／policyVersion 這類字串型 context 綁定用
 *     electric field 表示要嘛要 hash 成 field element、要嘛要另外設計，效益不高）。
 *   - ZK 電路真正該負責、也是 commission 命題要求的部分，是「總碳足跡的加總與合規判斷
 *     不洩漏各階段分量」——這正是這個模組做的事。
 *   - 兩層合起來：context-binding 防「這份 proof 是不是被套到別的案件／批次／年度」，
 *     zk 電路防「總數字是不是真的從私密分量正確加總出來、且落在合規區間」。
 *
 * Node 環境（server/index.js）：assets 用 fs 自動載入，不需要額外設定。
 * Cloudflare Workers 環境（worker/index.js）：fs 不可用，且 ffjavascript／circom_runtime
 * 內部會呼叫 WebAssembly.compile 動態編譯 wasm bytes，被 workerd 擋下（見
 * services/proof/workersWasmCompat.js 開頭註解的完整技術說明）。worker/index.js 要在
 * 應用邏輯執行前，把靜態 import 到的 wasm bytes/Module 呼叫 configureZkAssets() 注入。
 */

const path = require('path');
const { registerPrebuiltWasm, installWorkersWasmCompat } = require('./workersWasmCompat');

const CIRCUIT_INPUT_COUNT = 4;
const SCALE = 1_000_000;

const BN128_WASM_FINGERPRINT = 'eea61e66b72d1c0eb49c91521a25a8fa09a4d9d51c2fe74cabf596f48eea8639';
const CARBON_PROOF_WASM_FINGERPRINT = 'c906a7c7a3e93e3c36d2a8c5de2078e3906af58c24e7c2b16c5041c92654cc2a';

let assets = null; // { carbonProofWasmBytes: Uint8Array, zkeyBytes: Uint8Array, verificationKey: object }
let assetsSource = null; // 'node-fs' | 'injected' | null

/**
 * Workers 環境呼叫：把靜態 import 到的 wasm Module／bytes 注入。
 * @param {object} params
 * @param {Uint8Array} params.carbonProofWasmBytes - circuits/build/carbon_proof_js/carbon_proof.wasm 的 raw bytes
 * @param {WebAssembly.Module} params.carbonProofWasmModule - 同一份檔案的 build-time 靜態 import Module
 * @param {Uint8Array} params.zkeyBytes - circuits/build/carbon_proof_final.zkey 的 raw bytes
 * @param {object} params.verificationKey - circuits/build/verification_key.json 內容
 * @param {WebAssembly.Module} params.bn128WasmModule - ffjavascript bn128 曲線 wasm 的離線預編譯 Module
 */
function configureZkAssets({ carbonProofWasmBytes, carbonProofWasmModule, zkeyBytes, verificationKey, bn128WasmModule }) {
  if (!carbonProofWasmBytes || !zkeyBytes || !verificationKey) {
    throw new TypeError('configureZkAssets 需要 carbonProofWasmBytes／zkeyBytes／verificationKey。');
  }
  assets = { carbonProofWasmBytes, zkeyBytes, verificationKey };
  assetsSource = 'injected';
  if (carbonProofWasmModule) registerPrebuiltWasm(CARBON_PROOF_WASM_FINGERPRINT, carbonProofWasmModule);
  if (bn128WasmModule) registerPrebuiltWasm(BN128_WASM_FINGERPRINT, bn128WasmModule);
  installWorkersWasmCompat();
}

/** Node 環境用 fs 自動載入（第一次實際用到 zk 功能時才讀，不在 module load 時就強制要求檔案存在）。 */
function loadAssetsFromNodeFs() {
  // 延遲 require fs／path，Workers 環境下即使這個檔案被載入，只要不呼叫任何 zk 函式，
  // 就不會因為找不到 fs 而炸掉（Workers 有 nodejs_compat 的 fs 假實作，但真的呼叫
  // readFileSync 讀不到真實檔案，寧可讓下面的 try/catch 走到明確的錯誤訊息）。
  const fs = require('fs');
  const buildDir = path.join(__dirname, '..', '..', 'circuits', 'build');
  const carbonProofWasmBytes = fs.readFileSync(path.join(buildDir, 'carbon_proof_js', 'carbon_proof.wasm'));
  const zkeyBytes = fs.readFileSync(path.join(buildDir, 'carbon_proof_final.zkey'));
  const verificationKey = JSON.parse(fs.readFileSync(path.join(buildDir, 'verification_key.json'), 'utf8'));
  assets = { carbonProofWasmBytes, zkeyBytes, verificationKey };
  assetsSource = 'node-fs';
  installWorkersWasmCompat(); // Node 下這個 patch 幾乎不介入（原生 compile 直接成功），但統一路徑比較好維護。
}

function ensureAssets() {
  if (assets) return assets;
  try {
    loadAssetsFromNodeFs();
    return assets;
  } catch (err) {
    throw new Error(
      '[services/proof/zk] 找不到電路 assets（circuit wasm／zkey／verification key），且沒有透過 ' +
        'configureZkAssets() 注入。Node 環境請確認 circuits/build/ 底下的檔案存在；Cloudflare Workers ' +
        `環境要在 worker/index.js 用靜態 import 讀進來後呼叫 configureZkAssets()。原始錯誤：${err.message}`
    );
  }
}

/**
 * 供應商私密持有各製程階段排放分量，產生 zk-SNARK proof，證明
 * totalScaled = sum(quantityScaled[i] * factorScaled[i]) / SCALE 且 totalScaled <= complianceThresholdScaled，
 * 不洩漏 quantityScaled 本身。
 *
 * @param {object} params
 * @param {number[]} params.quantityScaled - 私密：4 個製程階段的排放分量（已用 SCALE=10^6 定點表示）
 * @param {number[]} params.factorScaled - 公開：對應的排放係數（SCALE=10^6 定點表示）
 * @param {number} params.complianceThresholdScaled - 公開：合規上限
 * @returns {Promise<{proof: object, publicSignals: string[], totalScaled: number, compliant: boolean}>}
 */
async function generateRealZkProof({ quantityScaled, factorScaled, complianceThresholdScaled }) {
  if (!Array.isArray(quantityScaled) || quantityScaled.length !== CIRCUIT_INPUT_COUNT) {
    throw new TypeError(`quantityScaled 必須是長度 ${CIRCUIT_INPUT_COUNT} 的陣列。`);
  }
  if (!Array.isArray(factorScaled) || factorScaled.length !== CIRCUIT_INPUT_COUNT) {
    throw new TypeError(`factorScaled 必須是長度 ${CIRCUIT_INPUT_COUNT} 的陣列。`);
  }
  const { carbonProofWasmBytes, zkeyBytes } = ensureAssets();
  const snarkjs = await import('snarkjs');

  const input = {
    quantityScaled: quantityScaled.map((v) => String(v)),
    factorScaled: factorScaled.map((v) => String(v)),
    complianceThresholdScaled: String(complianceThresholdScaled),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    new Uint8Array(carbonProofWasmBytes),
    new Uint8Array(zkeyBytes)
  );

  // 電路 public signal 輸出順序見 circuits/carbon_proof.circom 的 component main 宣告：
  // [totalScaled, compliant, factorScaled[0..3], complianceThresholdScaled]
  const totalScaled = Number(publicSignals[0]);
  const compliant = publicSignals[1] === '1';

  return { proof, publicSignals, totalScaled, compliant };
}

/**
 * 驗證一份 zk-SNARK proof。只需要 verification key（公開資料），不需要 wasm／zkey
 * （那兩個是 proving 專用的）。
 * @returns {Promise<boolean>}
 */
async function verifyRealZkProof({ proof, publicSignals }) {
  const { verificationKey } = ensureAssets();
  const snarkjs = await import('snarkjs');
  return snarkjs.groth16.verify(verificationKey, publicSignals, proof);
}

function _resetForTests() {
  assets = null;
  assetsSource = null;
}

module.exports = {
  SCALE,
  CIRCUIT_INPUT_COUNT,
  BN128_WASM_FINGERPRINT,
  CARBON_PROOF_WASM_FINGERPRINT,
  configureZkAssets,
  generateRealZkProof,
  verifyRealZkProof,
  _resetForTests,
  _getAssetsSourceForTests: () => assetsSource,
};
