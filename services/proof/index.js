'use strict';

/**
 * services/proof — Day 3 trust engine，ZKP 的「驗證」半邊（**demo commitment fallback**）。
 *
 * 誠實揭露（呼應 DAY3_TRUST_ENGINE_HANDOFF.md §13 Cut Plan 的 fallback 條款、以及分工
 * 計畫 p.9「ZKP 失敗備援順序」第三選擇「以 commitment／Hash 驗證流程展示，清楚標示 ZKP
 * 尚未在該環境執行」）：
 *
 *   這裡**沒有**跑 Circom/snarkjs 電路。`ProofEnvelope.proof` 是一段
 *   `demoOnly:sha256:<hex>` 的 **commitment**，內容是「circuitId + verificationKeyId +
 *   publicInputs + nonce」的 SHA-256 摘要。它**不是**零知識證明，也**不是**簽章：
 *   commitment 的輸入全部是公開值，任何人拿得到 publicInputs 就能自己重算出同一串。
 *   因此它能證明的只有「這份 envelope 的 proof 欄位跟它自己宣稱的公開輸入沒有被拆開
 *   替換」，**不能**證明公開輸入是由合法電路／合法持有人算出來的。
 *
 * 這個模組真正做到（不是 mock）的事：
 *   - proof commitment 現場重算，並以 crypto.timingSafeEqual 比對，偽造 proof bytes 會被擋。
 *   - 逐批（shipment-level）context 綁定：caseId／shipmentId／installationId／reportingYear／
 *     policyProfileId／policyVersion／policySnapshotHash／factorSetId／factorSetHash／
 *     nonce／expiry 任一不符 → PROOF_CONTEXT_MISMATCH（SHIP-A 的 proof 套到 SHIP-B 會失敗）。
 *   - 公開數值綁定：quantityTonnesScaled／allocatedEmissionsScaled／intensityCommitment／
 *     inputHash 任一不符 → PUBLIC_INPUT_MISMATCH。
 *   - expiresAt 過期 → PROOF_EXPIRED。
 *   - nonce 重放偵測，且**驗證全部通過後才消費 nonce**（見下方 nonce ledger 說明）。
 *
 * 正式版本要換掉的只有 `verifyCommitment()` 那一段（換成 snarkjs groth16.verify() +
 * verification key 查表），本模組對外介面（checks／reasonCodes／inputHash）不需要改。
 */

const crypto = require('crypto');
const { REASON_CODE } = require('../../packages/contracts/enums');

const NONCE_FORMAT = /^[A-Za-z0-9_-]{8,}$/;
const PROOF_COMMITMENT_PREFIX = 'demoOnly:sha256:';
const DEFAULT_VERIFICATION_KEY_ID = 'demo-vk-v1';

// Nonce ledger 預設參數。TTL 必須 >= proof TTL，否則過期回收後同一個 nonce 又能重放；
// 容量上限避免長時間執行的 Demo process 記憶體無限成長。
const DEFAULT_NONCE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_NONCE_CAPACITY = 5000;

/**
 * 「這份 proof 是不是被套到另一個案件／批次／年度／政策／係數」——身分與上下文綁定欄位。
 * 對應規格 p.12 ZKP public inputs 與分工計畫 p.8「案件綁定／規則綁定／重放防護」。
 * 任一不符一律 PROOF_CONTEXT_MISMATCH（規格 p.8 replayed_proof：SHIP-A proof 送往 SHIP-B）。
 */
const CONTEXT_BINDING_FIELDS = Object.freeze([
  'caseId',
  'shipmentId',
  'installationId',
  'reportingYear',
  'policyProfileId',
  'policyVersion',
  'policySnapshotHash',
  'factorSetId',
  'factorSetHash',
  'circuitId',
  'nonce',
  'expiry',
]);

/**
 * 「這份 proof 宣稱的數字對不對」——公開結果欄位。任一不符一律 PUBLIC_INPUT_MISMATCH
 * （規格 p.8 tampered_quantity：Proof 為 100 噸但 payload 改 120）。
 */
const VALUE_BINDING_FIELDS = Object.freeze([
  'quantityTonnesScaled',
  'allocatedEmissionsScaled',
  'intensityCommitment',
  'inputHash',
]);

const REQUIRED_ENVELOPE_FIELDS = Object.freeze([
  'proofId',
  'circuitId',
  'publicInputs',
  'proof',
  'nonce',
  'expiresAt',
  'verificationKeyId',
]);

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

/** demoOnly commitment：公開輸入 + nonce + 電路／verification key 身分的 SHA-256 摘要。 */
function buildProofCommitment({ circuitId, verificationKeyId, publicInputs, nonce }) {
  return `${PROOF_COMMITMENT_PREFIX}${sha256Hex({
    circuitId: circuitId === undefined ? null : circuitId,
    verificationKeyId: verificationKeyId === undefined ? null : verificationKeyId,
    publicInputs: publicInputs || null,
    nonce: nonce === undefined ? null : nonce,
  })}`;
}

/**
 * 固定時間字串比較；長度不同時仍做一次等長比較，不用長度提早 return 洩漏資訊。
 * 主要走 `crypto.timingSafeEqual`；某些精簡 runtime（例如部分 Workers 相容層）沒有
 * 這個函式時退回等價的常數時間 XOR 迴圈，行為相同、不會靜默改成非常數時間比較。
 */
function timingSafeBufferEqual(a, b) {
  if (typeof crypto.timingSafeEqual === 'function') return crypto.timingSafeEqual(a, b);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

function timingSafeStringEqual(actual, expected) {
  const actualBuffer = Buffer.from(typeof actual === 'string' ? actual : '', 'utf8');
  const expectedBuffer = Buffer.from(typeof expected === 'string' ? expected : '', 'utf8');
  if (actualBuffer.length !== expectedBuffer.length) {
    timingSafeBufferEqual(expectedBuffer, expectedBuffer);
    return false;
  }
  return timingSafeBufferEqual(actualBuffer, expectedBuffer);
}

/** intensity 的公開 commitment（分工計畫 p.8「公開結果：allocatedEmissions／intensity commitment」）。 */
function buildIntensityCommitment({ intensityScaled, installationId, reportingYear }) {
  return sha256Hex({ intensityScaled, installationId, reportingYear });
}

// ---------------------------------------------------------------------------
// Nonce ledger
// ---------------------------------------------------------------------------

/**
 * Demo 用的記憶體 nonce ledger。
 *
 * ⚠️ 已知限制（不得對外宣稱「完整 replay protection」）：
 *   - 這是**單一 process 記憶體**。`npm start`（單一 Node process）內有效；重啟即清空。
 *   - Cloudflare Workers 是多 isolate／多 region 執行，**跨 isolate 不共享**這份記錄，
 *     同一個 nonce 打到另一個 isolate 不會被擋。Workers 上只能宣稱「單 isolate 內偵測到
 *     重放」，完整重放防護需要 Durable Object／KV／D1 之類的持久化 ledger。
 *   - 想接持久化版本時用 `setNonceLedger(adapter)` 注入，介面只需要
 *     `has(nonce, now)`、`consumeAll(nonces, now)`、`clear()`、`size()`。
 */
function createMemoryNonceLedger(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_NONCE_TTL_MS;
  const maxEntries =
    Number.isInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : DEFAULT_NONCE_CAPACITY;
  const entries = new Map(); // nonce -> 失效時間（epoch ms）

  function prune(nowMs) {
    for (const [nonce, expiresAtMs] of entries) {
      if (expiresAtMs <= nowMs) entries.delete(nonce);
    }
  }

  function evictOldest(needed) {
    const ordered = [...entries.entries()].sort((a, b) => a[1] - b[1]);
    let index = 0;
    while (entries.size + needed > maxEntries && index < ordered.length) {
      entries.delete(ordered[index][0]);
      index += 1;
    }
  }

  return {
    kind: 'memory',
    ttlMs,
    maxEntries,
    demoOnly: true,
    crossIsolateSafe: false,
    has(nonce, now) {
      prune((now instanceof Date ? now : new Date()).getTime());
      return entries.has(nonce);
    },
    /**
     * 原子消費：整批 nonce 要嘛全部記錄成功、要嘛完全不動。任何一個已被用過（或這一批
     * 內部自己重複）就整批拒絕，呼叫端不會出現「一半 nonce 被吃掉」的中間狀態。
     */
    consumeAll(nonces, now) {
      const nowMs = (now instanceof Date ? now : new Date()).getTime();
      prune(nowMs);
      const list = Array.isArray(nonces) ? nonces : [];
      const unique = [...new Set(list)];
      if (unique.length !== list.length) {
        return { ok: false, reason: 'DUPLICATE_IN_BATCH', nonce: null };
      }
      const already = unique.find((nonce) => entries.has(nonce));
      if (already !== undefined) {
        return { ok: false, reason: 'ALREADY_CONSUMED', nonce: already };
      }
      if (entries.size + unique.length > maxEntries) evictOldest(unique.length);
      if (entries.size + unique.length > maxEntries) {
        return { ok: false, reason: 'LEDGER_CAPACITY_EXCEEDED', nonce: null };
      }
      unique.forEach((nonce) => entries.set(nonce, nowMs + ttlMs));
      return { ok: true, consumed: unique };
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}

let nonceLedger = createMemoryNonceLedger();

/** Adapter hook：可注入 Durable Object／KV 版本的 ledger（見 createMemoryNonceLedger 註解）。 */
function setNonceLedger(adapter) {
  if (
    !adapter ||
    typeof adapter.has !== 'function' ||
    typeof adapter.consumeAll !== 'function' ||
    typeof adapter.clear !== 'function' ||
    typeof adapter.size !== 'function'
  ) {
    throw new TypeError('Nonce ledger adapter must implement has/consumeAll/clear/size.');
  }
  nonceLedger = adapter;
  return nonceLedger;
}

function getNonceLedger() {
  return nonceLedger;
}

/**
 * 消費一整批 nonce——**只有在呼叫端把所有驗證都跑完且全部通過之後**才可以呼叫。
 * 失敗的請求不呼叫這個函式，因此不會占用 nonce（避免攻擊者用大量無效請求把
 * 正常使用者的 nonce 毒掉）。
 */
function consumeNonces(nonces, options = {}) {
  return nonceLedger.consumeAll(nonces, options.now);
}

// ---------------------------------------------------------------------------
// 產生 / 驗證
// ---------------------------------------------------------------------------

/**
 * 產生一份 Demo 用 ProofEnvelope（逐批）。publicInputs 由呼叫端（trustAdapter）依
 * workflow 當下的真實案件快照算好傳進來，這個函式不重新計算業務邏輯，只負責封裝 +
 * 產生 nonce／expiry／commitment。
 */
function generateDemoProofEnvelope({
  circuitId,
  publicInputs,
  verificationKeyId = DEFAULT_VERIFICATION_KEY_ID,
  ttlMs = 5 * 60 * 1000,
  nonce: fixedNonce,
  now,
}) {
  const nonce = fixedNonce || crypto.randomBytes(16).toString('hex');
  const baseMs = (now instanceof Date ? now : new Date()).getTime();
  const expiry = new Date(baseMs + ttlMs).toISOString();
  const boundPublicInputs = { ...(publicInputs || {}), nonce, expiry };
  return {
    proofId: `demo-proof-${crypto.randomBytes(6).toString('hex')}`,
    circuitId,
    publicInputs: boundPublicInputs,
    proof: buildProofCommitment({ circuitId, verificationKeyId, publicInputs: boundPublicInputs, nonce }),
    nonce,
    expiresAt: expiry,
    verificationKeyId,
    demoOnly: true,
  };
}

/**
 * 驗證一份 ProofEnvelope 是否綁定到 `expected` 這組**由系統獨立算出來**的上下文。
 *
 * 這個函式**不會**消費 nonce——它只檢查 nonce 是否已被用過並把 nonce 回傳給呼叫端；
 * 呼叫端要在整組驗證（所有批次 + Gate）都通過後才呼叫 `consumeNonces()`。
 *
 * @param {object} envelope - canonical ProofEnvelope（見 schema-v1.json）
 * @param {object} expected - 系統重算出來的期望值；欄位見 CONTEXT_BINDING_FIELDS / VALUE_BINDING_FIELDS
 * @param {object} [options] - { now: Date }
 * @returns {{ok: boolean, checks: object[], reasonCodes: string[], inputHash?: string, nonce?: string}}
 */
function verifyProofEnvelope(envelope, expected, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const expectedContext = expected || {};
  const checks = [];
  const reasonCodes = [];
  const label = expectedContext.shipmentId ? `[${expectedContext.shipmentId}] ` : '';

  function fail(reasonCode, detail) {
    checks.push(makeCheck('proof_check', 'fail', `${label}${detail}`));
    reasonCodes.push(reasonCode);
    return { ok: false, checks, reasonCodes };
  }

  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return fail(REASON_CODE.PROOF_INVALID, 'ProofEnvelope 缺失或格式錯誤。');
  }

  const missing = REQUIRED_ENVELOPE_FIELDS.filter(
    (field) => envelope[field] === undefined || envelope[field] === null
  );
  if (missing.length) {
    return fail(REASON_CODE.PROOF_INVALID, `ProofEnvelope 缺少必填欄位：${missing.join(', ')}`);
  }
  if (!envelope.publicInputs || typeof envelope.publicInputs !== 'object' || Array.isArray(envelope.publicInputs)) {
    return fail(REASON_CODE.PROOF_INVALID, 'ProofEnvelope.publicInputs 必須是物件。');
  }
  checks.push(makeCheck('proof_shape', 'pass', `${label}ProofEnvelope 必填欄位齊全`));

  if (typeof envelope.nonce !== 'string' || !NONCE_FORMAT.test(envelope.nonce)) {
    return fail(REASON_CODE.PROOF_INVALID, `nonce 格式不合法：${JSON.stringify(envelope.nonce)}`);
  }
  checks.push(makeCheck('nonce_format', 'pass', `${label}nonce 格式合法`));

  // 只「查」不「消費」：nonce 在呼叫端確認整組驗證全過之後才會被 consumeNonces() 記錄。
  if (nonceLedger.has(envelope.nonce, now)) {
    return fail(REASON_CODE.NONCE_REUSED, `nonce ${envelope.nonce} 已被使用過，判定為重放攻擊。`);
  }
  checks.push(makeCheck('nonce_replay', 'pass', `${label}nonce 未出現在 replay ledger`));

  const expiresAtMs = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
    return fail(REASON_CODE.PROOF_EXPIRED, `Proof 已於 ${envelope.expiresAt} 過期。`);
  }
  checks.push(makeCheck('proof_expiry', 'pass', `${label}Proof 於 ${envelope.expiresAt} 前有效`));

  // publicInputs 內的 nonce/expiry 必須跟 envelope 本體一致，否則 commitment 綁的是
  // 另一組重放參數。這兩個欄位一併走下面的 context 綁定比對。
  const publicInputs = envelope.publicInputs;
  const contextExpectations = {
    ...expectedContext,
    circuitId: expectedContext.circuitId,
    nonce: envelope.nonce,
    expiry: envelope.expiresAt,
  };

  const contextMismatches = [];
  for (const field of CONTEXT_BINDING_FIELDS) {
    if (contextExpectations[field] === undefined) continue;
    const claimed = field === 'circuitId' ? envelope.circuitId : publicInputs[field];
    if (claimed !== contextExpectations[field]) {
      contextMismatches.push(
        `${field}（Proof 宣稱 ${JSON.stringify(claimed)}，案件實際為 ${JSON.stringify(contextExpectations[field])}）`
      );
    }
  }
  if (contextMismatches.length) {
    return fail(
      REASON_CODE.PROOF_CONTEXT_MISMATCH,
      `Proof 綁定的上下文與案件實際快照不一致：${contextMismatches.join('；')}`
    );
  }
  checks.push(
    makeCheck('context_binding', 'pass', `${label}case／shipment／installation／year／policy／factor／nonce／expiry 綁定一致`)
  );

  const valueMismatches = [];
  for (const field of VALUE_BINDING_FIELDS) {
    if (expectedContext[field] === undefined) continue;
    if (publicInputs[field] !== expectedContext[field]) {
      valueMismatches.push(
        field === 'inputHash'
          ? 'inputHash（跟系統重算的 CalculationReceipt 不一致）'
          : `${field}（Proof 宣稱 ${JSON.stringify(publicInputs[field])}，案件實際為 ${JSON.stringify(expectedContext[field])}）`
      );
    }
  }
  if (valueMismatches.length) {
    return fail(REASON_CODE.PUBLIC_INPUT_MISMATCH, `公開輸入與實際資料不一致：${valueMismatches.join('；')}`);
  }
  checks.push(makeCheck('public_input_binding', 'pass', `${label}公開數值與 CalculationReceipt／批次分攤一致`));

  // demoOnly commitment 現場重算 + 固定時間比對：偽造／竄改 proof bytes 會在這裡被擋。
  const recomputed = buildProofCommitment({
    circuitId: envelope.circuitId,
    verificationKeyId: envelope.verificationKeyId,
    publicInputs,
    nonce: envelope.nonce,
  });
  if (!timingSafeStringEqual(envelope.proof, recomputed)) {
    return fail(
      REASON_CODE.PROOF_INVALID,
      'ProofEnvelope.proof 的 demoOnly commitment 重算後不相符（偽造或被竄改）。'
    );
  }
  checks.push(
    makeCheck(
      'proof_commitment',
      'pass',
      `${label}demoOnly commitment 已現場重算並以 timingSafeEqual 比對通過（這是 hash commitment，不是密碼學證明）`
    )
  );

  checks.push(
    makeCheck(
      'cryptographic_proof',
      'skipped',
      'demoOnly：本環境未執行 zk-SNARK 電路驗證，只做 commitment 重算與公開輸入綁定；正式版本待接 snarkjs groth16.verify()'
    )
  );

  return {
    ok: true,
    checks,
    reasonCodes: [],
    inputHash: publicInputs.inputHash,
    nonce: envelope.nonce,
  };
}

function _resetForTests() {
  nonceLedger.clear();
}

module.exports = {
  CONTEXT_BINDING_FIELDS,
  VALUE_BINDING_FIELDS,
  PROOF_COMMITMENT_PREFIX,
  buildProofCommitment,
  buildIntensityCommitment,
  createMemoryNonceLedger,
  setNonceLedger,
  getNonceLedger,
  consumeNonces,
  generateDemoProofEnvelope,
  verifyProofEnvelope,
  _resetForTests,
};
