'use strict';

const { REASON_CODE } = require('../packages/contracts/enums');
const { toScaled, addScaled } = require('../packages/contracts/fixedPoint');
const { buildCalculationReceipt } = require('../services/carbon-core');
const { resolveFactorSet } = require('../services/factor-registry');
const { verifyProofEnvelope, generateDemoProofEnvelope } = require('../services/proof');
const { evaluateGate } = require('../services/policy-gate');
const normalFixture = require('../fixtures/normal.json');

const TRUST_SERVICE_NAMES = ['proof', 'gate'];
const STABLE_REASON_CODE = /^[A-Z][A-Z0-9_]*$/;

function unavailableResult() {
  return {
    proof: {
      status: 'unavailable',
      verification: 'not_verified',
      checks: [],
      reasonCodes: ['PROOF_SERVICE_UNAVAILABLE'],
    },
    gate: {
      status: 'unavailable',
      verification: 'not_verified',
      checks: [],
      reasonCodes: ['GATE_SERVICE_UNAVAILABLE'],
    },
  };
}

function validateServiceResult(name, value) {
  if (!TRUST_SERVICE_NAMES.includes(name) || !value || typeof value !== 'object') {
    throw new TypeError('Invalid trust adapter service result.');
  }
  if (!['available', 'unavailable', 'error'].includes(value.status)) {
    throw new TypeError('Invalid trust adapter service status.');
  }
  if (!['verified', 'not_verified', 'failed'].includes(value.verification)) {
    throw new TypeError('Invalid trust adapter verification.');
  }
  if (value.status === 'available' && value.verification === 'not_verified') {
    throw new TypeError('Available trust adapter service must be verified or failed.');
  }
  if (value.verification === 'verified' && value.status !== 'available') {
    throw new TypeError('Verified trust adapter service must be available.');
  }
  if (!Array.isArray(value.checks) || !Array.isArray(value.reasonCodes)) {
    throw new TypeError('Trust adapter checks and reasonCodes must be arrays.');
  }
  if (value.reasonCodes.some((code) => !STABLE_REASON_CODE.test(code))) {
    throw new TypeError('Trust adapter reasonCodes must be stable codes.');
  }
  if (
    value.verification === 'verified' &&
    (typeof value.inputHash !== 'string' || !value.inputHash.trim())
  ) {
    throw new TypeError('Verified trust adapter service requires inputHash.');
  }
  return {
    status: value.status,
    verification: value.verification,
    checks: value.checks,
    reasonCodes: value.reasonCodes,
    ...(value.inputHash ? { inputHash: value.inputHash } : {}),
  };
}

function validateResult(result) {
  if (!result || typeof result !== 'object') {
    throw new TypeError('Invalid trust adapter result.');
  }
  const keys = Object.keys(result);
  if (
    keys.length !== TRUST_SERVICE_NAMES.length ||
    TRUST_SERVICE_NAMES.some((name) => !keys.includes(name))
  ) {
    throw new TypeError('Trust adapter result must include proof and gate only.');
  }
  return Object.fromEntries(
    TRUST_SERVICE_NAMES.map((name) => [name, validateServiceResult(name, result[name])])
  );
}

// ---------------------------------------------------------------------------
// Day 3 — 真實 trust engine（services/proof + services/factor-registry +
// services/policy-gate），取代預設的 unavailable evaluator。
//
// 誠實揭露：`services/proof` 沒有真的跑 zk-SNARK 電路（見該模組檔頭註解），是
// demoOnly 的公開輸入綁定檢查，不是 production-grade cryptographic proof。
// reasonCodes／checks／inputHash 契約是真的、會真的擋下攻擊 fixture，只有「proof
// bytes 本身有沒有密碼學保證」這件事還沒做，不得對外宣稱已完成正式 ZKP 驗證。
// ---------------------------------------------------------------------------

/**
 * 組合 Factor Registry + Proof 驗證 + Policy Gate 三者的結果，映射成
 * trustAdapter.evaluate() 的 { proof, gate } service-readiness 形狀。
 * 刻意獨立匯出（不只是 evaluate() 內部細節），讓 tests/trust 可以直接組出
 * 攻擊情境（自訂 proofEnvelope／factorSetId／policyProfile），不用被 evaluate()
 * 的窄接口（只吃 caseId/policyProfileId/inputHash）綁死。
 *
 * @param {object} input
 * @param {string} input.caseId
 * @param {string} input.policyProfileId
 * @param {string} [input.inputHash] - CalculationReceipt.inputHash；缺失時 proof 判定失敗
 * @param {object} input.policyProfile - canonical PolicyProfile（含 circuitId／allowedFactorSets）
 * @param {string} input.factorSetId
 * @param {object} input.proofEnvelope - canonical ProofEnvelope
 * @param {number} [input.quantityTonnesScaled] - 10^6 定點整數，供 PUBLIC_INPUT_MISMATCH 比對
 * @param {boolean} [input.evidenceReady] - 預設 true；false 時 Gate 直接判 NEEDS_EVIDENCE
 * @param {Date} [input.now]
 */
function evaluateTrustScenario(input) {
  const now = input.now instanceof Date ? input.now : new Date();
  const policyProfile = input.policyProfile || {};
  const factorResult = resolveFactorSet(input.factorSetId, { policyProfile, now });

  const proofResult = input.inputHash
    ? verifyProofEnvelope(
        input.proofEnvelope,
        {
          caseId: input.caseId,
          policyProfileId: input.policyProfileId,
          circuitId: policyProfile.circuitId,
          inputHash: input.inputHash,
          quantityTonnesScaled: input.quantityTonnesScaled,
        },
        { now }
      )
    : {
        ok: false,
        checks: [{ name: 'proof_check', status: 'fail', detail: '尚無可綁定的 CalculationReceipt inputHash，無法驗證 Proof。' }],
        reasonCodes: [REASON_CODE.PROOF_INVALID],
      };

  const gateResult = evaluateGate({
    policyProfileId: input.policyProfileId,
    factorResult,
    proofResult,
    evidenceReady: input.evidenceReady !== false,
    inputHash: input.inputHash || null,
    now,
  });

  const proof = {
    status: 'available',
    verification: proofResult.ok ? 'verified' : 'failed',
    checks: proofResult.checks,
    reasonCodes: proofResult.ok ? [] : proofResult.reasonCodes,
    ...(proofResult.ok && proofResult.inputHash ? { inputHash: proofResult.inputHash } : {}),
  };
  const gate = {
    status: 'available',
    verification: gateResult.decision === 'GATE_OK' ? 'verified' : 'failed',
    checks: gateResult.checks,
    reasonCodes: gateResult.reasonCodes,
    ...(gateResult.decision === 'GATE_OK' && gateResult.inputHash ? { inputHash: gateResult.inputHash } : {}),
  };

  return { proof, gate, gateResult };
}

/**
 * Demo 案件（CASE-2026-001，唯一一份 fixtures/normal.json）目前「正確答案」的
 * 情境上下文——policyProfile／factorSetId／inputHash／quantityTonnesScaled 都是
 * 依 normalFixture 現場重算，不是寫死的常數，normalFixture 改了這裡就會跟著變。
 */
function getDemoContext() {
  const receipt = buildCalculationReceipt({
    installationYear: normalFixture.installationYear,
    activities: normalFixture.activities,
    factorSet: normalFixture.factorSet,
    policyProfile: normalFixture.policyProfile,
  });
  const quantityTonnesScaled = (normalFixture.shipments || []).reduce(
    (sum, shipment) => addScaled(sum, toScaled(shipment.quantityTonnes)),
    0
  );
  return {
    caseId: normalFixture.case.caseId,
    policyProfile: normalFixture.policyProfile,
    factorSetId: normalFixture.factorSet.factorSetId,
    inputHash: receipt.inputHash,
    quantityTonnesScaled,
  };
}

/**
 * 正式（非 unavailable）evaluator：每次呼叫都針對「當下」的 Demo 案件重新產生一份
 * ProofEnvelope 並重新跑完整驗證鏈——不是回傳寫死的 verified 結果。只要
 * fixtures/normal.json 的資料本身沒被竄改，這裡永遠會驗證通過；如果 workflowApi
 * 傳進來的 inputHash 跟這裡重算的不一致（代表案件被改過但沒重新走 carbon-core），
 * 一樣會被 verifyProofEnvelope 的 PUBLIC_INPUT_MISMATCH 檔下來。
 */
async function productionEvaluator(input) {
  const context = getDemoContext();
  const caseId = (input && input.caseId) || context.caseId;
  const policyProfileId = (input && input.policyProfileId) || context.policyProfile.policyProfileId;
  const inputHash = (input && input.inputHash) || context.inputHash;

  const proofEnvelope = generateDemoProofEnvelope({
    caseId,
    policyProfileId,
    circuitId: context.policyProfile.circuitId,
    inputHash,
    quantityTonnesScaled: context.quantityTonnesScaled,
  });

  const { proof, gate } = evaluateTrustScenario({
    caseId,
    policyProfileId,
    inputHash,
    policyProfile: context.policyProfile,
    factorSetId: context.factorSetId,
    proofEnvelope,
    quantityTonnesScaled: context.quantityTonnesScaled,
    evidenceReady: true,
  });
  return { proof, gate };
}

// 冷開機（module 第一次被 require，還沒有任何測試呼叫過
// setEvaluatorForTests/resetEvaluatorForTests）預設走這個正式 evaluator，讓真正的
// server（npm start / wrangler dev，從來不會呼叫測試專用的 setter）一啟動
// revalidate 就是 Day 3 真實信任引擎，不用額外在 server/index.js 或 worker/index.js
// 另外接線。resetEvaluatorForTests() 刻意維持原本語意（見下方），不受這個改動影響。
let evaluator = productionEvaluator;

async function evaluate(input) {
  return validateResult(await evaluator(input));
}

function setEvaluatorForTests(nextEvaluator) {
  if (typeof nextEvaluator !== 'function') {
    throw new TypeError('Trust evaluator must be a function.');
  }
  evaluator = nextEvaluator;
}

/**
 * 刻意重置回「服務不可用」的 stub，不是重置回 productionEvaluator——延續 Day 2
 * 既有 smoke test 的契約（tests/workflow/smoke.js「revalidate: default adapter
 * 回 unavailable 且不會 READY」），沒有測試會因為 Day 3 接了真引擎而改變語意。
 * 想要在測試裡驗證真引擎行為，改用 `setEvaluatorForTests(productionEvaluator)`
 * 或直接呼叫 `evaluateTrustScenario`/`getDemoContext`。
 */
function resetEvaluatorForTests() {
  evaluator = async function evaluateUnavailable() {
    return unavailableResult();
  };
}

module.exports = {
  evaluate,
  resetEvaluatorForTests,
  setEvaluatorForTests,
  unavailableResult,
  validateResult,
  // Day 3 exports — trust engine 內部組件，供 tests/trust 直接組攻擊情境使用。
  evaluateTrustScenario,
  getDemoContext,
  productionEvaluator,
};
