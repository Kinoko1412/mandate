'use strict';

/**
 * tests/identity/smoke.js — services/identity（Day 5 背景待辦 1，vLEI 身份驗證接進新
 * canonical schema）的攻擊矩陣。跟其他 trust engine 測試套件同一種風格（純 assert、
 * 無外部框架）。
 */

const assert = require('assert');
const { verifyIdentityContext, GATE_DECISION } = require('../../services/identity');

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${label}`);
    console.log(`      ${error.stack || error.message}`);
  }
}

function baseContext(overrides = {}) {
  return {
    actorId: 'actor-supplier-steel-01',
    orgId: 'ORG-TW-STEEL-SUPPLIER',
    role: 'Supplier',
    assuranceLevel: 'vLEI-QVI',
    credentialRefs: ['LE-STEEL-01', 'ROLE-STEEL-01-OOR'],
    mandateId: 'MANDATE-DEMO-01',
    expiresAt: '2027-12-31T00:00:00Z',
    revocationStatus: 'ACTIVE', // 宣稱值，正式驗證結果不能只看這個欄位
    ...overrides,
  };
}

function main() {
  check('normal: 正常法人+角色憑證鏈通過驗證', () => {
    const result = verifyIdentityContext(baseContext());
    assert.strictEqual(result.decision, GATE_DECISION.OK);
    assert.deepStrictEqual(result.reasonCodes, []);
    assert.ok(result.checks.some((c) => c.name === 'role_credentials' && c.status === 'pass'));
  });

  check('attack: 未知 actorId（不在 Registry 內）視為未經核准，即使宣稱 revocationStatus=ACTIVE', () => {
    const result = verifyIdentityContext(baseContext({ actorId: 'actor-does-not-exist', credentialRefs: [] }));
    assert.strictEqual(result.decision, GATE_DECISION.BLOCKED);
    assert.ok(result.reasonCodes.includes('AUTHORIZATION_INVALID'));
  });

  check('attack: 法人憑證已撤銷 → 撤銷連鎖，即使呼叫端宣稱 revocationStatus=ACTIVE 也一樣被擋（不信任宣稱值）', () => {
    const result = verifyIdentityContext(
      baseContext({ actorId: 'actor-supplier-revoked-01', orgId: 'ORG-DEMO-REVOKED-SUPPLIER', revocationStatus: 'ACTIVE' })
    );
    assert.strictEqual(result.decision, GATE_DECISION.BLOCKED);
    assert.ok(result.reasonCodes.includes('AUTHORIZATION_REVOKED'));
    assert.ok(/法人憑證.*已撤銷/.test(result.checks.at(-1).detail));
  });

  check('attack: 法人／角色憑證已過期', () => {
    const result = verifyIdentityContext(
      baseContext({ actorId: 'actor-supplier-expired-01', orgId: 'ORG-DEMO-EXPIRED-SUPPLIER' })
    );
    assert.strictEqual(result.decision, GATE_DECISION.BLOCKED);
    assert.ok(result.reasonCodes.includes('IDENTITY_CREDENTIAL_EXPIRED'));
  });

  check('attack: 偽造 credentialRefs（宣稱 Registry 裡不存在的憑證 ID）被擋下', () => {
    const result = verifyIdentityContext(baseContext({ credentialRefs: ['LE-STEEL-01', 'ROLE-FORGED-99'] }));
    assert.strictEqual(result.decision, GATE_DECISION.BLOCKED);
    assert.ok(result.reasonCodes.includes('AUTHORIZATION_INVALID'));
    assert.ok(/偽造/.test(result.checks.at(-1).detail));
  });

  check('attack: orgId 宣稱值跟 Registry 記錄的真實 orgId 不符（冒用他人身份綁自己的組織）', () => {
    const result = verifyIdentityContext(baseContext({ orgId: 'ORG-SOMEONE-ELSE' }));
    assert.strictEqual(result.decision, GATE_DECISION.BLOCKED);
    assert.ok(result.reasonCodes.includes('AUTHORIZATION_INVALID'));
  });

  check('shape: 缺 actorId 直接判定格式錯誤', () => {
    const result = verifyIdentityContext({});
    assert.strictEqual(result.decision, GATE_DECISION.BLOCKED);
    assert.ok(result.reasonCodes.includes('AUTHORIZATION_INVALID'));
  });

  check('deterministic: 同樣輸入的 inputHash 每次一致', () => {
    const ctx = baseContext();
    const r1 = verifyIdentityContext(ctx, { now: new Date('2026-08-25T00:00:00Z') });
    const r2 = verifyIdentityContext(ctx, { now: new Date('2026-08-25T00:00:00Z') });
    assert.strictEqual(r1.inputHash, r2.inputHash);
  });

  console.log('');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
