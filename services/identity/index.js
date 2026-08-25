'use strict';

/**
 * services/identity — Day 5 背景待辦 1：把 vLEI 身份驗證邏輯接進新的 canonical schema。
 *
 * 這是**全新實作**，不是舊 fork（`_reference/vlei-old-fork/vleiCheck.js`，青禾零件情境）
 * 的復原——舊架構用記憶體 session store，新架構的 `IdentityContext`（見
 * packages/contracts/schema-v1.json）形狀完全不同。這裡只參考舊邏輯的**判斷精神**
 * （法人憑證＋角色憑證、撤銷連鎖、I2I 指標檢查），用跟 `services/factor-registry`／
 * `services/policy-gate` 已經確立的同一套模式（demo registry + checks/reasonCodes 陣列 +
 * 期望值由系統重建、不信任呼叫端宣稱）重新實作。
 *
 * 對齊 Day 3 已確立的 GateResult 慣例：回傳 `{decision, reasonCodes, checks,
 * evaluatedAt, inputHash}`，`decision` 用跟 policy-gate 一致的 GATE_OK / BLOCKED 字串
 * （不是布林值），跟其他 trust engine 模組的呼叫端習慣一致。
 *
 * 跟 services/factor-registry 同樣的兩層防偽精神：呼叫端宣稱的 `identityContext`
 * （actorId／credentialRefs／revocationStatus）只當「宣稱值」拿來比對，**真正的憑證狀態
 * 一律從這裡的 registry 重新查、不信任呼叫端輸入**——避免「自己說自己還沒被撤銷」這種
 * 自簽自驗漏洞。
 */

const crypto = require('crypto');
const { REASON_CODE } = require('../../packages/contracts/enums');

const GATE_DECISION = Object.freeze({ OK: 'GATE_OK', BLOCKED: 'BLOCKED' });

function makeCheck(name, status, detail) {
  return { name, status, detail };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function inputHash(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function isExpired(credential, nowMs) {
  if (!credential || !credential.expiresAt) return false;
  return Date.parse(credential.expiresAt) <= nowMs;
}

/**
 * 寫死的 Demo 身份憑證清單（跟 services/factor-registry 的 FACTOR_REGISTRY 同一種
 * 「不是真的資料庫，是黑客松 Demo 情境」的定位），keyed by actorId。每筆記錄模擬
 * GLEIF → QVI → 法人憑證 → 角色憑證(OOR/ECR) 這條鏈的**結果**（不重新實作整條 QVI 發證
 * 流程，那不是這個專案的範圍）。
 */
const IDENTITY_REGISTRY = Object.freeze({
  'actor-supplier-steel-01': Object.freeze({
    orgId: 'ORG-TW-STEEL-SUPPLIER',
    legalEntityCredential: Object.freeze({
      credentialId: 'LE-STEEL-01',
      status: 'active',
      expiresAt: '2027-12-31T00:00:00Z',
    }),
    roleCredentials: Object.freeze([
      Object.freeze({
        credentialId: 'ROLE-STEEL-01-OOR',
        role: 'OOR',
        issuerCredentialId: 'LE-STEEL-01',
        status: 'active',
        expiresAt: '2027-12-31T00:00:00Z',
      }),
    ]),
    demoOnly: true,
  }),
  'actor-supplier-revoked-01': Object.freeze({
    orgId: 'ORG-DEMO-REVOKED-SUPPLIER',
    legalEntityCredential: Object.freeze({
      credentialId: 'LE-REVOKED-01',
      status: 'revoked',
      revokedAt: '2026-06-30T00:00:00Z',
      expiresAt: '2027-12-31T00:00:00Z',
    }),
    roleCredentials: Object.freeze([
      Object.freeze({
        credentialId: 'ROLE-REVOKED-01-ECR',
        role: 'ECR',
        issuerCredentialId: 'LE-REVOKED-01',
        // 撤銷連鎖：法人憑證撤銷時，底下角色憑證視同一併撤銷（見 verifyIdentityChain 判斷邏輯，
        // 不是靠這裡預先寫死 status，跟真實撤銷發生順序一致：法人先撤，角色連帶失效）。
        status: 'active',
        expiresAt: '2027-12-31T00:00:00Z',
      }),
    ]),
    demoOnly: true,
  }),
  'actor-supplier-expired-01': Object.freeze({
    orgId: 'ORG-DEMO-EXPIRED-SUPPLIER',
    legalEntityCredential: Object.freeze({
      credentialId: 'LE-EXPIRED-01',
      status: 'active',
      expiresAt: '2025-01-01T00:00:00Z', // 已過期
    }),
    roleCredentials: Object.freeze([
      Object.freeze({
        credentialId: 'ROLE-EXPIRED-01-ECR',
        role: 'ECR',
        issuerCredentialId: 'LE-EXPIRED-01',
        status: 'active',
        expiresAt: '2025-01-01T00:00:00Z',
      }),
    ]),
    demoOnly: true,
  }),
});

function getIdentityRecord(actorId) {
  return IDENTITY_REGISTRY[actorId] || null;
}

/**
 * @param {object} identityContext - canonical IdentityContext（呼叫端宣稱值）
 * @param {object} [options]
 * @param {Date} [options.now]
 * @returns {{decision: string, reasonCodes: string[], checks: object[], evaluatedAt: string, inputHash: string}}
 */
function verifyIdentityContext(identityContext, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const evaluatedAt = now.toISOString();
  const checks = [];
  const reasonCodes = [];

  function fail(reasonCode, detail) {
    checks.push(makeCheck('identity_check', 'fail', detail));
    reasonCodes.push(reasonCode);
    return {
      decision: GATE_DECISION.BLOCKED,
      reasonCodes,
      checks,
      evaluatedAt,
      inputHash: inputHash(identityContext),
    };
  }

  if (!identityContext || typeof identityContext !== 'object') {
    return fail(REASON_CODE.AUTHORIZATION_INVALID, 'IdentityContext 缺失或格式錯誤。');
  }
  const { actorId, orgId, credentialRefs } = identityContext;
  if (typeof actorId !== 'string' || !actorId.trim()) {
    return fail(REASON_CODE.AUTHORIZATION_INVALID, 'IdentityContext.actorId 缺失。');
  }
  checks.push(makeCheck('identity_shape', 'pass', 'IdentityContext 必填欄位齊全'));

  // 真正的憑證狀態一律從 registry 重新查，不信任呼叫端宣稱的 revocationStatus——
  // 這是這個模組存在的核心價值：呼叫端說「我還沒被撤銷」不算數。
  const record = getIdentityRecord(actorId);
  if (!record) {
    return fail(REASON_CODE.AUTHORIZATION_INVALID, `actorId ${actorId} 不在身份憑證 Registry 內，視為未經核准的身份。`);
  }
  checks.push(makeCheck('registry_lookup', 'pass', `身份憑證 Registry 找到 ${actorId}`));

  if (orgId && orgId !== record.orgId) {
    return fail(
      REASON_CODE.AUTHORIZATION_INVALID,
      `IdentityContext.orgId 宣稱 ${JSON.stringify(orgId)}，跟 Registry 記錄的 ${JSON.stringify(record.orgId)} 不符。`
    );
  }
  checks.push(makeCheck('org_binding', 'pass', 'orgId 與 Registry 記錄一致'));

  const le = record.legalEntityCredential;
  if (!le) {
    return fail(REASON_CODE.AUTHORIZATION_INVALID, '缺少法人憑證，無法建立身份鏈。');
  }
  if (le.status === 'revoked') {
    return fail(REASON_CODE.AUTHORIZATION_REVOKED, `法人憑證 ${le.credentialId} 已撤銷，其下所有角色憑證同步失效。`);
  }
  if (isExpired(le, now.getTime())) {
    return fail(REASON_CODE.IDENTITY_CREDENTIAL_EXPIRED, `法人憑證 ${le.credentialId} 已過期。`);
  }
  checks.push(makeCheck('legal_entity_credential', 'pass', `法人憑證 ${le.credentialId} 有效`));

  const roles = Array.isArray(record.roleCredentials) ? record.roleCredentials : [];
  if (!roles.length) {
    return fail(REASON_CODE.AUTHORIZATION_INVALID, '法人憑證底下沒有任何角色憑證，無人被授權簽署碳數據。');
  }

  for (const role of roles) {
    // I2I（Issuer-to-Issuee）指標檢查：角色憑證的核發依據必須指向這張法人憑證本身，
    // 防止「拿別家法人憑證底下的角色憑證冒用」。
    if (role.issuerCredentialId !== le.credentialId) {
      return fail(REASON_CODE.AUTHORIZATION_INVALID, `角色憑證 ${role.credentialId} 未正確指向法人憑證，I2I 檢查失敗。`);
    }
    if (role.status === 'revoked') {
      return fail(REASON_CODE.AUTHORIZATION_REVOKED, `角色憑證 ${role.credentialId}（${role.role || 'ECR'}）已撤銷。`);
    }
    if (isExpired(role, now.getTime())) {
      return fail(REASON_CODE.IDENTITY_CREDENTIAL_EXPIRED, `角色憑證 ${role.credentialId} 已過期。`);
    }
  }
  checks.push(makeCheck('role_credentials', 'pass', `${roles.length} 張角色憑證通過 I2I 檢查、未撤銷、未過期`));

  if (Array.isArray(credentialRefs) && credentialRefs.length) {
    const knownIds = new Set([le.credentialId, ...roles.map((r) => r.credentialId)]);
    const unknown = credentialRefs.filter((ref) => !knownIds.has(ref));
    if (unknown.length) {
      return fail(
        REASON_CODE.AUTHORIZATION_INVALID,
        `IdentityContext.credentialRefs 宣稱了 Registry 記錄裡沒有的憑證 ID：${unknown.join(', ')}（可能是偽造）。`
      );
    }
    checks.push(makeCheck('credential_refs_binding', 'pass', 'credentialRefs 全部對得上 Registry 記錄的真實憑證 ID'));
  }

  return {
    decision: GATE_DECISION.OK,
    reasonCodes: [],
    checks,
    evaluatedAt,
    inputHash: inputHash(identityContext),
  };
}

// ---------------------------------------------------------------------------
// Day 5：簽發碳足跡憑證（services/credential）需要每個身份有一把簽章金鑰。
// ---------------------------------------------------------------------------
//
// 每個 registry 裡的 actorId 在模組載入時各自產生一把真的 Ed25519 金鑰對（不是假的）。
// **已知限制**（跟 services/proof 的 in-memory nonce ledger 同一種、已經是這個專案一路
// 誠實標記的限制類型）：金鑰只存在這次 process 的記憶體，重啟就換一把新的——用這把舊金鑰
// 簽出去的憑證，重啟後會驗證失敗。真實世界裡這把私鑰應該由供應商自己持有、不會給平台碰，
// 這裡刻意把「簽發」也放在同一個 demo 系統內只是為了讓 hackathon 展示可以端到端跑起來。
const SIGNING_KEYS = new Map();
function getSigningKeyPair(actorId) {
  if (!IDENTITY_REGISTRY[actorId]) return null;
  if (!SIGNING_KEYS.has(actorId)) {
    SIGNING_KEYS.set(actorId, crypto.generateKeyPairSync('ed25519'));
  }
  return SIGNING_KEYS.get(actorId);
}

module.exports = {
  GATE_DECISION,
  IDENTITY_REGISTRY,
  getIdentityRecord,
  verifyIdentityContext,
  getSigningKeyPair,
};
