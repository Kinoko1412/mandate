// circuits/workers-compat-check/worker.js — 可重跑的 Cloudflare Workers 相容性驗證。
// 用 `npx wrangler dev --config circuits/workers-compat-check/wrangler.toml` 啟動後
// 打 `GET /`，應該回傳 fullProve + verify 都成功、且竄改過的 publicSignals 會被正確拒絕。
// 詳細背景見 circuits/README.md「Cloudflare Workers 相容性」一節。
import bn128WasmModule from '../build/bn128.wasm';
import carbonProofWasmModule from '../build/carbon_proof_js/carbon_proof.wasm';
import carbonProofWasmBytes from '../build/carbon_proof_js/carbon_proof.wasm.bin';
import zkeyBytes from '../build/carbon_proof_final.zkey.bin';
import verificationKey from '../build/verification_key.json';
import { registerPrebuiltWasm, installWorkersWasmCompat } from '../../services/proof/workersWasmCompat.js';
import { configureZkAssets, generateRealZkProof, verifyRealZkProof } from '../../services/proof/zk.js';

// 見 circuits/README.md「問題 1」：ffjavascript 在模組頂層就會呼叫 URL.createObjectURL，
// workerd 沒有實作，靜態 import snarkjs 之前一定要先頂住這個呼叫。
try {
  URL.createObjectURL = () => 'blob:workers-compat-check-stub';
  URL.revokeObjectURL = () => {};
} catch (e) {
  /* ignore */
}

configureZkAssets({
  carbonProofWasmBytes: new Uint8Array(carbonProofWasmBytes),
  carbonProofWasmModule,
  zkeyBytes: new Uint8Array(zkeyBytes),
  verificationKey,
  bn128WasmModule,
});
installWorkersWasmCompat();
registerPrebuiltWasm; // 已透過 configureZkAssets 內部呼叫，這裡只是避免 lint 抱怨未使用 import

export default {
  async fetch() {
    const steps = [];
    try {
      steps.push('assets configured');
      const result = await generateRealZkProof({
        quantityScaled: [10_000_000, 20_000_000, 30_000_000, 40_000_000],
        factorScaled: [1_800_000, 1_800_000, 1_800_000, 1_800_000],
        complianceThresholdScaled: 200_000_000,
      });
      steps.push('fullProve returned');

      const verifyOk = await verifyRealZkProof({ proof: result.proof, publicSignals: result.publicSignals });
      steps.push('verify (valid) returned');

      const tampered = [...result.publicSignals];
      tampered[0] = '1';
      const tamperedOk = await verifyRealZkProof({ proof: result.proof, publicSignals: tampered });
      steps.push('verify (tampered) returned');

      return new Response(
        JSON.stringify({
          ok: true,
          steps,
          totalScaled: result.totalScaled,
          compliant: result.compliant,
          verifyValidProof: verifyOk, // 應為 true
          verifyTamperedProof: tamperedOk, // 應為 false
          passed: verifyOk === true && tamperedOk === false,
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, steps, message: String((err && err.stack) || err) }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
  },
};
