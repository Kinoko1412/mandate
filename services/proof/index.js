'use strict';

/**
 * services/proof — Day 3 trust engine，ZKP 的「驗證」半邊。
 *
 * 誠實揭露（呼應 DAY3_TRUST_ENGINE_HANDOFF.md §13 Cut Plan 的 fallback 條款）：
 * 這裡**沒有**真的跑 Circom/snarkjs 電路，`proof` 欄位是一個 demoOnly 的示意字串
 * （sha256 摘要，不是零知識證明）。這個模組做的是「電路外能做、且值得做」的事——
 * 把 ProofEnvelope 的公開輸入（inputHash／quantityTonnesScaled／caseId／policyProfileId）
 * 跟系統當下實際算出來的值逐項比對、檢查 nonce 未被重放、檢查 circuitId 跟 PolicyProfile
 * 綁定一致、檢查 Proof 未過期——這些檢查本身是真的（不是 mock），只有「這組公開輸入真的
 * 是由合法電路算出來的」這件事沒有密碼學保證。正式 production 版本要把 `proof` 換成
 * 真實 snarkjs 產生的 proof bytes、並在這裡呼叫真的 groth16.verify()，介面（checks／
 * reasonCodes／inputHash）不需要跟著改。
 */

const crypto = require('crypto');
const { REASON_CODE } = require('../../packages/contracts/enums');

const NONCE_FORMAT = /^[A-Za-z0-9_-]{8,}$/;

// Demo 用的 nonce replay 記錄——同一個 process 存活期間有效，重啟即清空
// （符合 hand-off §12「Demo 用 Node 跑 proof」的記憶體限制假設，跟 workflowStore 一致）。
const usedNonces = new Set();

function makeCheck(name, status, detail) {
  return { name, status, detail };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * 產生一份 Demo 用 ProofEnvelope——每次呼叫都是新的 proofId／nonce／expiresAt，
 * 模擬「每次重驗都重新產生一次 Proof」的真實流程（正式電路會在這裡被呼叫）。
 * quantityTonnesScaled／inputHash 是呼叫端（trustAdapter）依當下 carbon-core
 * 計算結果算好傳進來的，這個函式不重新計算業務邏輯。
 */
function generateDemoProofEnvelope({
  caseId,
  policyProfileId,
  circuitId,
  inputHash,
  quantityTonnesScaled,
  ttlMs = 5 * 60 * 1000,
}) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const publicInputs = { caseId, policyProfileId, inputHash, quantityTonnesScaled };
  return {
    proofId: `demo-proof-${crypto.randomBytes(6).toString('hex')}`,
    circuitId,
    publicInputs,
    proof: `demoOnly:sha256:${sha256Hex({ publicInputs, nonce })}`,
    nonce,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    verificationKeyId: 'demo-vk-v1',
    demoOnly: true,
  };
}

/**
 * 驗證一份 ProofEnvelope 是否跟預期的公開輸入綁定一致、未過期、nonce 未重放、
 * circuitId 跟 PolicyProfile 一致。
 *
 * @param {object} envelope - ProofEnvelope（canonical 形狀，見 schema-v1.json）
 * @param {object} expected - { caseId, policyProfileId, circuitId, inputHash, quantityTonnesScaled }
 * @param {object} [options] - { now: Date }
 */
function verifyProofEnvelope(envelope, expected, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const checks = [];
  const reasonCodes = [];

  function fail(reasonCode, detail) {
    checks.push(makeCheck('proof_check', 'fail', detail));
    reasonCodes.push(reasonCode);
    return { ok: false, checks, reasonCodes };
  }

  if (!envelope || typeof envelope !== 'object') {
    return fail(REASON_CODE.PROOF_INVALID, 'ProofEnvelope 缺失或格式錯誤。');
  }

  const requiredFields = [
    'proofId', 'circuitId', 'publicInputs', 'proof', 'nonce', 'expiresAt', 'verificationKeyId',
  ];
  const missing = requiredFields.filter((field) => envelope[field] === undefined || envelope[field] === null);
  if (missing.length) {
    return fail(REASON_CODE.PROOF_INVALID, `ProofEnvelope 缺少必填欄位：${missing.join(', ')}`);
  }
  checks.push(makeCheck('proof_shape', 'pass', 'ProofEnvelope 必填欄位齊全'));

  if (typeof envelope.nonce !== 'string' || !NONCE_FORMAT.test(envelope.nonce)) {
    return fail(REASON_CODE.PROOF_INVALID, `nonce 格式不合法：${JSON.stringify(envelope.nonce)}`);
  }
  checks.push(makeCheck('nonce_format', 'pass', 'nonce 格式合法'));

  // Nonce replay：先查再消費，同一個 nonce 第二次出現一律 BLOCKED，
  // 不管這次夾帶的其他欄位是否合法——重放本身就是攻擊訊號。
  if (usedNonces.has(envelope.nonce)) {
    return fail(REASON_CODE.NONCE_REUSED, `nonce ${envelope.nonce} 已被使用過，判定為重放攻擊。`);
  }
  usedNonces.add(envelope.nonce);
  checks.push(makeCheck('nonce_replay', 'pass', 'nonce 首次出現'));

  if (expected && expected.circuitId && envelope.circuitId !== expected.circuitId) {
    return fail(
      REASON_CODE.PROOF_CONTEXT_MISMATCH,
      `ProofEnvelope.circuitId (${envelope.circuitId}) 跟 PolicyProfile.circuitId (${expected.circuitId}) 不一致。`
    );
  }
  checks.push(makeCheck('circuit_binding', 'pass', 'circuitId 與 PolicyProfile 一致'));

  const expiresAtMs = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
    return fail(REASON_CODE.PROOF_EXPIRED, `Proof 已於 ${envelope.expiresAt} 過期。`);
  }
  checks.push(makeCheck('proof_expiry', 'pass', `Proof 於 ${envelope.expiresAt} 前有效`));

  const publicInputs = envelope.publicInputs || {};
  const mismatches = [];
  if (expected) {
    if (expected.caseId !== undefined && publicInputs.caseId !== expected.caseId) {
      mismatches.push(`caseId（宣稱 ${publicInputs.caseId}，實際 ${expected.caseId}）`);
    }
    if (expected.policyProfileId !== undefined && publicInputs.policyProfileId !== expected.policyProfileId) {
      mismatches.push(`policyProfileId（宣稱 ${publicInputs.policyProfileId}，實際 ${expected.policyProfileId}）`);
    }
    if (expected.inputHash !== undefined && publicInputs.inputHash !== expected.inputHash) {
      mismatches.push('inputHash（跟 CalculationReceipt 重算結果不一致）');
    }
    if (
      expected.quantityTonnesScaled !== undefined &&
      publicInputs.quantityTonnesScaled !== expected.quantityTonnesScaled
    ) {
      mismatches.push(
        `quantityTonnesScaled（Proof 宣稱 ${publicInputs.quantityTonnesScaled}，實際批次資料為 ${expected.quantityTonnesScaled}）`
      );
    }
  }
  if (mismatches.length) {
    return fail(REASON_CODE.PUBLIC_INPUT_MISMATCH, `公開輸入與實際資料不一致：${mismatches.join('；')}`);
  }
  checks.push(makeCheck('public_input_binding', 'pass', '公開輸入與 CalculationReceipt/批次資料一致'));

  checks.push(makeCheck(
    'cryptographic_proof',
    'skipped',
    'demoOnly：這裡沒有真的驗證 zk-SNARK proof bytes，只驗證公開輸入綁定與 envelope 契約，正式版本待接 snarkjs groth16.verify()'
  ));

  return { ok: true, checks, reasonCodes: [], inputHash: publicInputs.inputHash };
}

function _resetForTests() {
  usedNonces.clear();
}

module.exports = {
  generateDemoProofEnvelope,
  verifyProofEnvelope,
  _resetForTests,
};
