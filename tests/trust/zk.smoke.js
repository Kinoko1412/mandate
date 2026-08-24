'use strict';

/**
 * tests/trust/zk.smoke.js — 真 zk-SNARK 電路（circuits/carbon_proof.circom +
 * services/proof/zk.js）的端到端測試。跟 tests/trust/smoke.js（demoOnly commitment，
 * 43 項既有測試）完全獨立，不共用任何 state，也不改動既有測試的任何斷言。
 *
 * 只在 Node 環境跑（`node tests/trust/zk.smoke.js`）。Workers 環境的相容性測試在
 * circuits/workers-compat-check/（需要 `wrangler dev`，不是這個 npm test 套件的一部分，
 * 原因與怎麼手動重跑都寫在 circuits/README.md）。
 */

const assert = require('assert');
const zk = require('../../services/proof/zk');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failed += 1;
  }
}

async function main() {
  await test('normal: 電路正確算出 total 並判定合規', async () => {
    const result = await zk.generateRealZkProof({
      quantityScaled: [10_000_000, 20_000_000, 30_000_000, 40_000_000], // 10+20+30+40 噸
      factorScaled: [1_800_000, 1_800_000, 1_800_000, 1_800_000], // 1.80 tCO2e/噸
      complianceThresholdScaled: 200_000_000, // 200 tCO2e 上限
    });
    assert.strictEqual(result.totalScaled, 180_000_000, 'total 應為 180 * 1e6（100 噸 * 1.80）');
    assert.strictEqual(result.compliant, true, '180 <= 200 應判定合規');
    const ok = await zk.verifyRealZkProof({ proof: result.proof, publicSignals: result.publicSignals });
    assert.strictEqual(ok, true, '合法 proof 應驗證通過');
  });

  await test('non-compliant: 超過合規上限時 compliant 輸出應為 false，但 proof 仍然有效', async () => {
    const result = await zk.generateRealZkProof({
      quantityScaled: [50_000_000, 50_000_000, 50_000_000, 50_000_000], // 200 噸
      factorScaled: [1_800_000, 1_800_000, 1_800_000, 1_800_000],
      complianceThresholdScaled: 200_000_000, // 200 噸 * 1.80 = 360 > 200 上限
    });
    assert.strictEqual(result.totalScaled, 360_000_000);
    assert.strictEqual(result.compliant, false, '360 > 200 應判定不合規');
    const ok = await zk.verifyRealZkProof({ proof: result.proof, publicSignals: result.publicSignals });
    assert.strictEqual(ok, true, 'compliant=false 也是一個誠實、可驗證的合法 proof（不是驗證失敗）');
  });

  await test('attack — 竄改 publicSignals：verify 必須拒絕', async () => {
    const result = await zk.generateRealZkProof({
      quantityScaled: [10_000_000, 20_000_000, 30_000_000, 40_000_000],
      factorScaled: [1_800_000, 1_800_000, 1_800_000, 1_800_000],
      complianceThresholdScaled: 200_000_000,
    });
    const tampered = [...result.publicSignals];
    tampered[0] = String(1); // 把宣稱的總排放量從 180e6 改成 1
    const ok = await zk.verifyRealZkProof({ proof: result.proof, publicSignals: tampered });
    assert.strictEqual(ok, false, '竄改過 publicSignals 的 proof 必須驗證失敗');
  });

  await test('attack — 私密輸入超出 range check（企圖用 field wraparound 偽造小額申報）：proving 必須失敗', async () => {
    await assert.rejects(
      () =>
        zk.generateRealZkProof({
          quantityScaled: [2 ** 64, 0, 0, 0], // 超出電路宣告的 64-bit 範圍
          factorScaled: [1_800_000, 1_800_000, 1_800_000, 1_800_000],
          complianceThresholdScaled: 200_000_000,
        }),
      /Assert Failed/,
      '超出 range check 的私密輸入應該讓 witness generation 直接失敗，不能被拿去產生一個看似合法的 proof'
    );
  });

  await test('attack — proof 套用到不同的 publicSignals 陣列（偽造來源）：verify 必須拒絕', async () => {
    const a = await zk.generateRealZkProof({
      quantityScaled: [10_000_000, 20_000_000, 30_000_000, 40_000_000],
      factorScaled: [1_800_000, 1_800_000, 1_800_000, 1_800_000],
      complianceThresholdScaled: 200_000_000,
    });
    const b = await zk.generateRealZkProof({
      quantityScaled: [5_000_000, 5_000_000, 5_000_000, 5_000_000],
      factorScaled: [1_800_000, 1_800_000, 1_800_000, 1_800_000],
      complianceThresholdScaled: 200_000_000,
    });
    const ok = await zk.verifyRealZkProof({ proof: a.proof, publicSignals: b.publicSignals });
    assert.strictEqual(ok, false, 'A 的 proof 套用 B 的 publicSignals 必須被拒絕');
  });

  await test('deterministic: 同樣輸入的電路輸出（totalScaled/compliant）每次都一致', async () => {
    const r1 = await zk.generateRealZkProof({
      quantityScaled: [10_000_000, 20_000_000, 30_000_000, 40_000_000],
      factorScaled: [1_800_000, 1_800_000, 1_800_000, 1_800_000],
      complianceThresholdScaled: 200_000_000,
    });
    const r2 = await zk.generateRealZkProof({
      quantityScaled: [10_000_000, 20_000_000, 30_000_000, 40_000_000],
      factorScaled: [1_800_000, 1_800_000, 1_800_000, 1_800_000],
      complianceThresholdScaled: 200_000_000,
    });
    assert.strictEqual(r1.totalScaled, r2.totalScaled);
    assert.strictEqual(r1.compliant, r2.compliant);
    // proof 本身因為 groth16 用了隨機 blinding factor，每次產生的 proof bytes 不會相同——
    // 這是 groth16 的正常、必要行為（不是 bug），兩份 proof 各自都要能獨立驗證通過。
    assert.notDeepStrictEqual(r1.proof, r2.proof, 'groth16 每次 proof 應該不同（random blinding），這是預期行為');
    assert.strictEqual(await zk.verifyRealZkProof(r1), true);
    assert.strictEqual(await zk.verifyRealZkProof(r2), true);
  });

  console.log('');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
