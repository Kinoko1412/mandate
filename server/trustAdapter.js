'use strict';

const { REASON_CODE } = require('../packages/contracts/enums');
const { toScaled, mulScaled } = require('../packages/contracts/fixedPoint');
const { buildCalculationReceipt } = require('../services/carbon-core');
const { resolveFactorSet } = require('../services/factor-registry');
const { resolvePolicyProfile } = require('../services/policy-registry');
const {
  verifyProofEnvelope,
  generateDemoProofEnvelope,
  buildProofCommitment,
  buildIntensityCommitment,
  consumeNonces,
} = require('../services/proof');
const zk = require('../services/proof/zk');
const identity = require('../services/identity');
const { evaluateGate, evaluateEvidenceCoverage } = require('../services/policy-gate');
const workflowStore = require('./workflowStore');

const TRUST_SERVICE_NAMES = ['proof', 'gate'];
const STABLE_REASON_CODE = /^[A-Z][A-Z0-9_]*$/;
const DEMO_ATTACK_SCENARIOS = Object.freeze([
  'tampered_quantity',
  'wrong_factor',
  'proof_context_swap',
]);

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
// Day 3 — 真實 trust engine（services/policy-registry + services/factor-registry +
// services/proof + services/policy-gate），取代預設的 unavailable evaluator。
//
// 誠實揭露（Day 5 追加③更新）：`services/proof`（envelope／nonce／context-binding 那層）
// 本身仍然是 demoOnly 的 SHA-256 commitment，不是 cryptographic proof——這層繼續防「這份
// proof 是不是被套到別的案件／批次／年度」。**但**正式 evaluator（productionEvaluator，
// 即時流程實際會走到的路徑）現在額外疊加了真的 zk-SNARK 驗證
// （evaluateTrustScenarioWithRealZk → verifyRealZkForShipment → services/proof/zk.js，
// 真 Circom 電路 + snarkjs groth16），對每一批獨立證明
// `intensityScaled × quantityTonnesScaled = allocatedEmissionsScaled` 且落在政策合規
// 門檻內。兩層合起來才是完整故事：commitment 層防「换批套用」，zk 層防「總數字是不是真的
// 從私密分量正確算出來」。只有設定了 complianceThresholdScaled 的政策版本（目前僅
// CBAM-STEEL-2026-v1）會觸發真電路，其餘版本這一步會顯示 skipped，不影響既有行為。
//
// P1 修正重點：期望值（expected context）一律由本模組從 **workflow store 持有的案件快照**
// 獨立重建——case、installationYear、shipments、evidence、以及 Policy／Factor Registry 的
// 權威記錄。呼叫端（workflowApi）傳進來的 `inputHash` 只被當作「宣稱值」拿來比對，絕不當作
// 期望值使用。
// ---------------------------------------------------------------------------

function makeCheck(name, status, detail) {
  return { name, status, detail };
}

/**
 * 從 workflow store 的實際案件快照重建 trust 期望上下文。
 * 沒有任何一個欄位來自呼叫端輸入。
 */
function buildCaseTrustContext(caseId, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const caseRecord = workflowStore.getCase(caseId);
  const installationYear = workflowStore.getInstallationYear(caseId);
  const context = workflowStore.getCaseContext(caseId);
  const carbon = workflowStore.getCarbon(caseId);
  const evidence = workflowStore.listEvidence(caseId);

  if (!caseRecord || !installationYear || !context || !carbon) {
    return {
      ok: false,
      reasonCode: REASON_CODE.MISSING_CALCULATION_CONTEXT,
      detail: `找不到案件 ${caseId} 的完整快照（case／installationYear／context／carbon）。`,
    };
  }

  // 1) Policy Registry 是權威來源；案件夾帶的 PolicyProfile 只是宣稱值。
  const policyResult = resolvePolicyProfile(caseRecord.policyProfileId, {
    caseRecord,
    installationYear,
    declaredPolicyProfile: context.policyProfile,
    now,
  });
  const policyRecord = policyResult.record;

  // 2) Factor Registry：allowedFactorSets 取自 registry 記錄，不取自案件夾帶的 policy。
  const factorResult = resolveFactorSet(context.factorSet && context.factorSet.factorSetId, {
    policyProfile: policyRecord || context.policyProfile,
    factorSet: context.factorSet,
    now,
  });

  // 3) 獨立重算 CalculationReceipt——這是 inputHash 的唯一期望來源。
  let receipt = null;
  let receiptError = null;
  try {
    receipt = buildCalculationReceipt({
      installationYear,
      activities: context.activities,
      factorSet: context.factorSet,
      policyProfile: context.policyProfile,
    });
  } catch (error) {
    receiptError = error;
  }

  // 4) 獨立重算每一批的分攤結果（intensity × quantity），並跟 store 內既有的
  //    carbon.shipments 逐批比對，攔「案件被改過但沒重新走 carbon-core」。
  const intensityScaled = toScaled(installationYear.verifiedIntensity);
  const storedShipments = new Map((carbon.shipments || []).map((shipment) => [shipment.shipmentId, shipment]));
  const shipmentExpectations = [];
  const shipmentMismatches = [];
  for (const shipment of context.shipments || []) {
    const quantityTonnesScaled = toScaled(shipment.quantityTonnes);
    const allocatedEmissionsScaled = mulScaled(intensityScaled, quantityTonnesScaled);
    const stored = storedShipments.get(shipment.shipmentId);
    if (!stored) {
      shipmentMismatches.push(`${shipment.shipmentId}（案件快照有這批，但已計算結果裡沒有）`);
      continue;
    }
    if (
      stored.installationId !== installationYear.installationId ||
      stored.reportingYear !== installationYear.reportingYear ||
      stored.caseId !== caseId
    ) {
      shipmentMismatches.push(`${shipment.shipmentId}（case／installation／year 綁定不一致）`);
      continue;
    }
    if (toScaled(stored.quantityTonnes) !== quantityTonnesScaled) {
      shipmentMismatches.push(
        `${shipment.shipmentId}（已計算數量 ${stored.quantityTonnes} 與案件快照 ${shipment.quantityTonnes} 不一致）`
      );
      continue;
    }
    if (
      typeof stored.allocatedEmissions !== 'number' ||
      toScaled(stored.allocatedEmissions) !== allocatedEmissionsScaled
    ) {
      shipmentMismatches.push(
        `${shipment.shipmentId}（已計算分攤排放與 intensity × quantity 重算結果不一致）`
      );
      continue;
    }
    shipmentExpectations.push({
      shipmentId: shipment.shipmentId,
      caseId,
      installationId: installationYear.installationId,
      reportingYear: installationYear.reportingYear,
      quantityTonnesScaled,
      allocatedEmissionsScaled,
      intensityCommitment: buildIntensityCommitment({
        intensityScaled,
        installationId: installationYear.installationId,
        reportingYear: installationYear.reportingYear,
      }),
    });
  }

  // 5) 證據涵蓋期間依實際上傳的 EvidenceItem metadata 計算，不寫死。
  const evidenceResult = evaluateEvidenceCoverage({
    installationYear,
    evidence,
    requiredEvidence: (policyRecord && policyRecord.requiredEvidence) || context.policyProfile.requiredEvidence,
  });

  return {
    ok: true,
    now,
    caseId,
    caseRecord,
    installationYear,
    caseContext: context,
    carbon,
    evidence,
    policyResult,
    policyRecord,
    factorResult,
    receipt,
    receiptError,
    expectedInputHash: receipt ? receipt.inputHash : null,
    storedInputHash:
      carbon.annual && carbon.annual.calculationReceipt ? carbon.annual.calculationReceipt.inputHash : null,
    intensityScaled,
    shipmentExpectations,
    shipmentMismatches,
    evidenceResult,
    circuitId: (policyRecord && policyRecord.circuitId) || null,
    policyVersion: (policyRecord && policyRecord.version) || null,
    policySnapshotHash: policyResult.policySnapshotHash,
    factorSetId: context.factorSet && context.factorSet.factorSetId,
    factorSetHash: factorResult.factorSetHash,
  };
}

/** 逐批的期望 public inputs（不含 nonce／expiry，那兩個由 envelope 自己帶）。 */
function expectedPublicInputs(trustContext, shipmentExpectation) {
  return {
    caseId: shipmentExpectation.caseId,
    shipmentId: shipmentExpectation.shipmentId,
    installationId: shipmentExpectation.installationId,
    reportingYear: shipmentExpectation.reportingYear,
    quantityTonnesScaled: shipmentExpectation.quantityTonnesScaled,
    allocatedEmissionsScaled: shipmentExpectation.allocatedEmissionsScaled,
    intensityCommitment: shipmentExpectation.intensityCommitment,
    policyProfileId: trustContext.caseRecord.policyProfileId,
    policyVersion: trustContext.policyVersion,
    policySnapshotHash: trustContext.policySnapshotHash,
    factorSetId: trustContext.factorSetId,
    factorSetHash: trustContext.factorSetHash,
    inputHash: trustContext.expectedInputHash,
  };
}

/**
 * 依 trust context 產生逐批 Demo ProofEnvelope。正式版本這一步會被「向 prover 索取
 * proof」取代——這裡產生的 envelope 一樣要走完整 verify 流程，不是直接標 verified。
 */
function generateShipmentProofEnvelopes(trustContext, options = {}) {
  return trustContext.shipmentExpectations.map((expectation) =>
    generateDemoProofEnvelope({
      circuitId: trustContext.circuitId,
      publicInputs: expectedPublicInputs(trustContext, expectation),
      ttlMs: options.ttlMs,
      now: trustContext.now,
    })
  );
}

function recommitDemoEnvelope(envelope) {
  return {
    ...envelope,
    proof: buildProofCommitment({
      circuitId: envelope.circuitId,
      verificationKeyId: envelope.verificationKeyId,
      publicInputs: envelope.publicInputs,
      nonce: envelope.nonce,
    }),
  };
}

/**
 * Demo-only attack harness. The caller can select only a fixed scenario name; no
 * arbitrary envelope, hash, factor, or public input crosses this boundary.
 */
function runDemoAttackScenario(scenario) {
  if (!DEMO_ATTACK_SCENARIOS.includes(scenario)) {
    throw new TypeError('Invalid demo attack scenario.');
  }
  const trustContext = buildCaseTrustContext(workflowStore.DEMO_CASE_ID);
  if (!trustContext.ok) {
    throw new TypeError('Demo trust context is unavailable.');
  }
  const honestEnvelopes = generateShipmentProofEnvelopes(trustContext);
  let attackedContext = trustContext;
  let proofEnvelopes = honestEnvelopes;

  if (scenario === 'tampered_quantity') {
    proofEnvelopes = honestEnvelopes.map((envelope, index) => {
      if (index !== 0) return envelope;
      return recommitDemoEnvelope({
        ...envelope,
        publicInputs: {
          ...envelope.publicInputs,
          quantityTonnesScaled: toScaled(120),
          allocatedEmissionsScaled: toScaled(216),
        },
      });
    });
  } else if (scenario === 'wrong_factor') {
    attackedContext = {
      ...trustContext,
      factorResult: resolveFactorSet('FS-SELF-MADE-FAKE', {
        policyProfile: { allowedFactorSets: ['FS-SELF-MADE-FAKE'] },
        now: trustContext.now,
      }),
    };
  } else {
    const [shipA] = honestEnvelopes;
    proofEnvelopes = [shipA, { ...shipA }];
  }

  const result = evaluateTrustScenario({
    trustContext: attackedContext,
    proofEnvelopes,
  });
  return {
    scenario,
    decision: result.gateResult.decision,
    reasonCodes: result.gateResult.reasonCodes,
    checks: result.gateResult.checks,
    demoOnly: true,
    storeModified: false,
  };
}

/**
 * 組合 Policy Registry + Factor Registry + 逐批 Proof 驗證 + 證據涵蓋四者的結果，
 * 映射成 trustAdapter.evaluate() 的 { proof, gate } service-readiness 形狀。
 *
 * 刻意獨立匯出，讓 tests/trust 可以直接注入攻擊用的 ProofEnvelope（偽造 commitment、
 * SHIP-A 套 SHIP-B、竄改數量、換年度／工廠等），而期望值仍然由 buildCaseTrustContext()
 * 從真實案件快照獨立產生。
 *
 * @param {object} input
 * @param {object} input.trustContext - buildCaseTrustContext() 的結果
 * @param {object[]} input.proofEnvelopes - 逐批 ProofEnvelope（順序不重要，用 shipmentId 對）
 * @param {string} [input.claimedInputHash] - 呼叫端宣稱的 inputHash，只用來比對，不當期望值
 */
function evaluateTrustScenario(input) {
  const trustContext = input.trustContext;
  const now = trustContext.now instanceof Date ? trustContext.now : new Date();
  const envelopes = Array.isArray(input.proofEnvelopes) ? input.proofEnvelopes : [];
  const inputHash = trustContext.expectedInputHash;

  const preflightChecks = [];
  const preflightReasonCodes = [];

  if (trustContext.receiptError || !inputHash) {
    preflightChecks.push(
      makeCheck('receipt_recompute', 'fail', '無法從案件快照重算 CalculationReceipt，Proof 無可綁定的 inputHash。')
    );
    preflightReasonCodes.push(REASON_CODE.MISSING_CALCULATION_CONTEXT);
  } else {
    preflightChecks.push(makeCheck('receipt_recompute', 'pass', '已從案件快照獨立重算 CalculationReceipt.inputHash'));
    if (trustContext.storedInputHash && trustContext.storedInputHash !== inputHash) {
      preflightChecks.push(
        makeCheck('stored_receipt_binding', 'fail', '已存檔的 CalculationReceipt.inputHash 與重算結果不一致。')
      );
      preflightReasonCodes.push(REASON_CODE.PUBLIC_INPUT_MISMATCH);
    } else {
      preflightChecks.push(makeCheck('stored_receipt_binding', 'pass', '已存檔的 CalculationReceipt 與重算結果一致'));
    }
    // 呼叫端宣稱的 inputHash 只能被驗證，不能被採信。
    if (input.claimedInputHash !== undefined && input.claimedInputHash !== null) {
      if (input.claimedInputHash !== inputHash) {
        preflightChecks.push(
          makeCheck('caller_input_hash', 'fail', '呼叫端提供的 inputHash 與系統重算結果不一致，拒絕採信。')
        );
        preflightReasonCodes.push(REASON_CODE.PUBLIC_INPUT_MISMATCH);
      } else {
        preflightChecks.push(makeCheck('caller_input_hash', 'pass', '呼叫端提供的 inputHash 與系統重算結果一致'));
      }
    }
  }

  if (trustContext.shipmentMismatches.length) {
    preflightChecks.push(
      makeCheck('shipment_recompute', 'fail', `批次重算與已存檔結果不一致：${trustContext.shipmentMismatches.join('；')}`)
    );
    preflightReasonCodes.push(REASON_CODE.CASE_CONTEXT_MISMATCH);
  } else {
    preflightChecks.push(
      makeCheck('shipment_recompute', 'pass', `${trustContext.shipmentExpectations.length} 批分攤已用 intensity × quantity 獨立重算並與已存檔結果一致`)
    );
  }

  const preflightResult = {
    ok: preflightReasonCodes.length === 0,
    checks: preflightChecks,
    reasonCodes: preflightReasonCodes,
  };

  // 逐批驗證：每一批都必須有一份綁到「這一批」的 ProofEnvelope。
  const envelopeByShipment = new Map();
  for (const envelope of envelopes) {
    const claimed = envelope && envelope.publicInputs && envelope.publicInputs.shipmentId;
    if (claimed !== undefined && !envelopeByShipment.has(claimed)) envelopeByShipment.set(claimed, envelope);
  }

  const proofResults = [];
  const usedEnvelopes = new Set();
  trustContext.shipmentExpectations.forEach((expectation, index) => {
    // 先照 shipmentId 對；對不到就照順序取一份，讓「SHIP-A proof 送到 SHIP-B」這種
    // 攻擊真的走進 verify 並被 PROOF_CONTEXT_MISMATCH 擋下，而不是靜默略過。
    let envelope = envelopeByShipment.get(expectation.shipmentId);
    if (!envelope) envelope = envelopes[index];
    if (!envelope || usedEnvelopes.has(envelope)) {
      proofResults.push({
        ok: false,
        checks: [
          makeCheck('proof_check', 'fail', `[${expectation.shipmentId}] 缺少對應的 ProofEnvelope。`),
        ],
        reasonCodes: [REASON_CODE.PROOF_INVALID],
      });
      return;
    }
    usedEnvelopes.add(envelope);
    proofResults.push(
      verifyProofEnvelope(
        envelope,
        {
          ...expectedPublicInputs(trustContext, expectation),
          circuitId: trustContext.circuitId,
        },
        { now }
      )
    );
  });

  if (!trustContext.shipmentExpectations.length) {
    proofResults.push({
      ok: false,
      checks: [makeCheck('proof_check', 'fail', '案件沒有任何可驗證的批次。')],
      reasonCodes: [REASON_CODE.CASE_CONTEXT_MISMATCH],
    });
  }

  const gateResult = evaluateGate({
    policyProfileId: trustContext.caseRecord.policyProfileId,
    policyResult: trustContext.policyResult,
    factorResult: trustContext.factorResult,
    proofResults: [preflightResult, ...proofResults],
    evidenceResult: trustContext.evidenceResult,
    inputHash: inputHash || trustContext.storedInputHash || null,
    now,
  });

  const proofOk = preflightResult.ok && proofResults.every((result) => result.ok);
  const proofChecks = [...preflightChecks, ...proofResults.flatMap((result) => result.checks || [])];
  const proofReasonCodes = proofOk
    ? []
    : [...new Set([...preflightReasonCodes, ...proofResults.flatMap((result) => (result.ok ? [] : result.reasonCodes || []))])];

  // nonce 只有在「所有批次 Proof 驗證通過 + Gate 判 GATE_OK」之後才原子消費。
  // 失敗的請求完全不動 ledger，攻擊者無法用大量無效請求把正常 nonce 毒掉。
  let nonceConsumption = null;
  if (proofOk && gateResult.decision === 'GATE_OK') {
    const nonces = proofResults.map((result) => result.nonce).filter(Boolean);
    nonceConsumption = consumeNonces(nonces, { now });
    if (!nonceConsumption.ok) {
      const detail =
        nonceConsumption.reason === 'LEDGER_CAPACITY_EXCEEDED'
          ? 'Demo nonce ledger 已達容量上限，無法登錄本次 nonce。'
          : `nonce 原子消費失敗（${nonceConsumption.reason}${nonceConsumption.nonce ? `：${nonceConsumption.nonce}` : ''}）。`;
      proofChecks.push(makeCheck('nonce_consume', 'fail', detail));
      const reasonCode =
        nonceConsumption.reason === 'LEDGER_CAPACITY_EXCEEDED' ? REASON_CODE.PROOF_INVALID : REASON_CODE.NONCE_REUSED;
      return finalize({
        trustContext,
        proofOk: false,
        proofChecks,
        proofReasonCodes: [reasonCode],
        gateResult: {
          ...gateResult,
          decision: 'BLOCKED',
          reasonCodes: [reasonCode],
          checks: [...gateResult.checks, makeCheck('nonce_consume', 'fail', detail)],
        },
        inputHash,
      });
    }
    proofChecks.push(
      makeCheck('nonce_consume', 'pass', `${nonceConsumption.consumed.length} 個 nonce 已在全部驗證通過後原子登錄`)
    );
  } else {
    proofChecks.push(
      makeCheck('nonce_consume', 'skipped', '本次驗證未全部通過，未消費任何 nonce（失敗請求不占用 nonce）')
    );
  }

  return finalize({ trustContext, proofOk, proofChecks, proofReasonCodes, gateResult, inputHash });
}

function finalize({ proofOk, proofChecks, proofReasonCodes, gateResult, inputHash }) {
  const proof = {
    status: 'available',
    verification: proofOk ? 'verified' : 'failed',
    checks: proofChecks,
    reasonCodes: proofOk ? [] : proofReasonCodes,
    ...(proofOk && inputHash ? { inputHash } : {}),
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
 * Day 5 追加③：把 `circuits/carbon_proof.circom` 的真 zk-SNARK 電路接進「逐批」驗證，
 * 對單一批次證明 `intensityScaled × quantityTonnesScaled = allocatedEmissionsScaled`
 * 且落在政策合規門檻內——電路輸入映射沿用 `services/credential/index.js` 已經在用、
 * 也是 `circuits/README.md` 當初寫好的建議路徑：
 *   quantityScaled = [intensityScaled, 0, 0, 0]        // 私密：製程效率
 *   factorScaled   = [quantityTonnesScaled, 0, 0, 0]   // 公開：這一批的出貨量
 * 電路算出的 totalScaled 因此等於 intensityScaled × quantityTonnesScaled，即
 * mulScaled() 已經在算的 allocatedEmissionsScaled——兩者算法一致，可以互相核對。
 *
 * 這是**額外疊加**在既有 verifyProofEnvelope（demo commitment）之上的第二層，不是取代它
 * ——跟 circuits/README.md、services/proof/zk.js 開頭記錄的架構決策一致。沒有設定
 * complianceThresholdScaled 的政策版本（目前只有 CBAM-STEEL-2026-v1 有設）直接跳過，
 * 回傳 skipped，不影響其他政策版本的既有行為。
 */
async function verifyRealZkForShipment(trustContext, expectation) {
  const threshold = trustContext.policyRecord && trustContext.policyRecord.complianceThresholdScaled;
  if (!Number.isFinite(threshold)) {
    return {
      ok: null,
      check: makeCheck(
        'real_zk_proof',
        'skipped',
        `[${expectation.shipmentId}] 此政策版本未設定 complianceThresholdScaled，略過真實 zk-SNARK 電路驗證。`
      ),
    };
  }
  try {
    const zkResult = await zk.generateRealZkProof({
      quantityScaled: [trustContext.intensityScaled, 0, 0, 0],
      factorScaled: [expectation.quantityTonnesScaled, 0, 0, 0],
      complianceThresholdScaled: threshold,
    });
    const proofValid = await zk.verifyRealZkProof({
      proof: zkResult.proof,
      publicSignals: zkResult.publicSignals,
    });
    if (!proofValid) {
      return {
        ok: false,
        reasonCode: REASON_CODE.PROOF_INVALID,
        check: makeCheck('real_zk_proof', 'fail', `[${expectation.shipmentId}] 真實 zk-SNARK proof 驗證失敗。`),
      };
    }
    // 只驗證 proof 本身合法還不夠——一定要交叉比對電路實際算出的 totalScaled 是不是真的
    // 等於已存檔的分攤結果，否則一份「自己算對、但跟這批貨無關」的合法 proof 也會被誤採信。
    // 跟 services/credential/index.js 的 verifyCarbonFootprintVC() 是同一種防禦縱深。
    if (zkResult.totalScaled !== expectation.allocatedEmissionsScaled) {
      return {
        ok: false,
        reasonCode: REASON_CODE.PUBLIC_INPUT_MISMATCH,
        check: makeCheck(
          'real_zk_proof',
          'fail',
          `[${expectation.shipmentId}] 電路算出的 totalScaled(${zkResult.totalScaled}) 與已存檔分攤結果(${expectation.allocatedEmissionsScaled}) 不一致。`
        ),
      };
    }
    return {
      ok: true,
      check: makeCheck(
        'real_zk_proof',
        'pass',
        `[${expectation.shipmentId}] 真實 zk-SNARK proof 驗證通過（totalScaled=${zkResult.totalScaled}，compliant=${zkResult.compliant}）`
      ),
    };
  } catch (error) {
    return {
      ok: false,
      reasonCode: REASON_CODE.PROOF_INVALID,
      check: makeCheck('real_zk_proof', 'fail', `[${expectation.shipmentId}] 真實 zk-SNARK proof 產生/驗證發生錯誤：${error.message}`),
    };
  }
}

/**
 * Day 5 追加③：vLEI 身份鏈驗證接進即時流程。`services/identity` 一直是獨立、沒人呼叫的
 * 模組——這裡讓案件的供應商組織（`caseRecord.supplierOrgId`）真的要在 vLEI Registry
 * 裡有一條有效的身份鏈（法人憑證＋角色憑證，未撤銷未過期），案件才能判 GATE_OK。
 *
 * `services/identity` 的 registry 主鍵是 actorId，跟 workflow 層的 `supplierOrgId` 目前
 * 各自獨立建立，用 `identity.findActorIdByOrgId()` 反查橋接（見該函式註解）。找不到對應
 * actorId，視同「這個組織沒有 vLEI 身份」，直接判定失敗，不是默默略過檢查。
 */
function verifyLiveIdentityForCase(trustContext) {
  const orgId = trustContext.caseRecord && trustContext.caseRecord.supplierOrgId;
  const actorId = orgId ? identity.findActorIdByOrgId(orgId) : null;
  if (!actorId) {
    return {
      ok: false,
      reasonCode: REASON_CODE.AUTHORIZATION_INVALID,
      check: makeCheck('vlei_identity', 'fail', `供應商組織 ${orgId || '(缺失)'} 不在 vLEI 身份憑證 Registry 內。`),
    };
  }
  const result = identity.verifyIdentityContext({ actorId, orgId });
  if (result.decision !== identity.GATE_DECISION.OK) {
    return {
      ok: false,
      reasonCode: result.reasonCodes[0] || REASON_CODE.AUTHORIZATION_INVALID,
      check: makeCheck(
        'vlei_identity',
        'fail',
        `供應商 vLEI 身份未通過驗證（${actorId}）：${result.reasonCodes.join(', ')}`
      ),
    };
  }
  return {
    ok: true,
    check: makeCheck('vlei_identity', 'pass', `供應商 ${orgId}（${actorId}）vLEI 身份鏈驗證通過`),
  };
}

/**
 * 包在既有（同步）evaluateTrustScenario() 外面的 async 疊加層，只給 productionEvaluator
 * 用——tests/trust/smoke.js 大量直接同步呼叫 evaluateTrustScenario() 組攻擊情境，刻意
 * 不改動那個函式的簽章/行為，避免動到那 40 幾項既有測試。既有防線（demo commitment、
 * policy/factor/evidence）沒過就不用多花時間跑真電路／查身份——這兩項是錦上添花的
 * 額外防線，不是取代既有防線的第一關守門，用 `gate.verification==='verified'`
 * 判斷「既有防線都過了」比只看 proof 更準確（Gate 還可能因為 evidence/policy 沒過）。
 */
async function evaluateTrustScenarioLive(input) {
  const result = evaluateTrustScenario(input);
  const trustContext = input.trustContext;
  if (!trustContext.ok || result.gate.verification !== 'verified') {
    return result;
  }

  const identityOutcome = verifyLiveIdentityForCase(trustContext);

  const zkOutcomes = [];
  for (const expectation of trustContext.shipmentExpectations) {
    zkOutcomes.push(await verifyRealZkForShipment(trustContext, expectation));
  }

  const extraChecks = [identityOutcome.check, ...zkOutcomes.map((outcome) => outcome.check)];
  const failedOutcomes = [identityOutcome, ...zkOutcomes].filter((outcome) => outcome.ok === false);

  if (!failedOutcomes.length) {
    return {
      ...result,
      proof: { ...result.proof, checks: [...result.proof.checks, ...extraChecks] },
    };
  }

  const extraReasonCodes = [...new Set(failedOutcomes.map((outcome) => outcome.reasonCode))];
  return {
    ...result,
    proof: {
      ...result.proof,
      verification: 'failed',
      checks: [...result.proof.checks, ...extraChecks],
      reasonCodes: [...new Set([...result.proof.reasonCodes, ...extraReasonCodes])],
    },
    gate: {
      ...result.gate,
      verification: 'failed',
      reasonCodes: [...new Set([...result.gate.reasonCodes, ...extraReasonCodes])],
    },
    gateResult: {
      ...result.gateResult,
      decision: 'BLOCKED',
      reasonCodes: [...new Set([...(result.gateResult.reasonCodes || []), ...extraReasonCodes])],
    },
  };
}

/**
 * 正式（非 unavailable）evaluator：每次呼叫都從 workflow store 當下的案件快照重建
 * 期望上下文、重新產生逐批 ProofEnvelope、再跑完整驗證鏈。呼叫端傳進來的 inputHash
 * 只被當成宣稱值比對；任何人塞任意 inputHash 都會得到 PUBLIC_INPUT_MISMATCH。
 */
async function productionEvaluator(input) {
  const caseId = (input && input.caseId) || workflowStore.DEMO_CASE_ID;
  const trustContext = buildCaseTrustContext(caseId);
  if (!trustContext.ok) {
    return {
      proof: {
        status: 'error',
        verification: 'failed',
        checks: [makeCheck('case_snapshot', 'fail', trustContext.detail)],
        reasonCodes: [trustContext.reasonCode],
      },
      gate: {
        status: 'error',
        verification: 'failed',
        checks: [makeCheck('case_snapshot', 'fail', trustContext.detail)],
        reasonCodes: [trustContext.reasonCode],
      },
    };
  }

  const proofEnvelopes = generateShipmentProofEnvelopes(trustContext);
  const { proof, gate } = await evaluateTrustScenarioLive({
    trustContext,
    proofEnvelopes,
    claimedInputHash: input && input.inputHash,
  });
  return { proof, gate };
}

// 冷開機預設就是正式 evaluator，真正的 server（npm start / wrangler dev）不需要另外接線。
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
 * P1 修正：重置回**正式** evaluator，不再是 unavailable stub。
 * 「重置」的語意應該是回到系統真正的預設行為；需要驗證 unavailable 路徑的測試，
 * 請明確 `setEvaluatorForTests(async () => trustAdapter.unavailableResult())`，
 * 讓「這個測試刻意讓服務掛掉」這件事在測試碼裡看得見。
 */
function resetEvaluatorForTests() {
  evaluator = productionEvaluator;
}

module.exports = {
  DEMO_ATTACK_SCENARIOS,
  evaluate,
  resetEvaluatorForTests,
  setEvaluatorForTests,
  unavailableResult,
  validateResult,
  // Day 3 exports — trust engine 內部組件，供 tests/trust 直接組攻擊情境使用。
  buildCaseTrustContext,
  expectedPublicInputs,
  generateShipmentProofEnvelopes,
  evaluateTrustScenario,
  evaluateTrustScenarioLive,
  verifyRealZkForShipment,
  verifyLiveIdentityForCase,
  runDemoAttackScenario,
  productionEvaluator,
};
