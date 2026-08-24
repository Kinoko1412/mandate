const { handleFetchRequest } = require('../server/apiFetch');
const supabaseSync = require('../server/supabaseSync');
const zkProof = require('../services/proof/zk');

// 真 zk-SNARK 電路在 Workers 需要的靜態資產（build-time import，見
// services/proof/workersWasmCompat.js 開頭註解為什麼一定要靜態 import，不能在
// 執行期動態讀檔/編譯）。這幾行本身沒有副作用，實際套用在下面 configureZkAssets()。
import bn128WasmModule from '../circuits/build/bn128.wasm';
import carbonProofWasmModule from '../circuits/build/carbon_proof_js/carbon_proof.wasm';
import carbonProofWasmBytes from '../circuits/build/carbon_proof_js/carbon_proof.wasm.bin';
import zkeyBytes from '../circuits/build/carbon_proof_final.zkey.bin';
import verificationKey from '../circuits/build/verification_key.json';

let zkAssetsConfigured = false;
function ensureZkAssetsConfigured() {
  if (zkAssetsConfigured) return;
  zkAssetsConfigured = true;
  zkProof.configureZkAssets({
    carbonProofWasmBytes: new Uint8Array(carbonProofWasmBytes),
    carbonProofWasmModule,
    zkeyBytes: new Uint8Array(zkeyBytes),
    verificationKey,
    bn128WasmModule,
  });
}

function applyWorkerEnv(env) {
  if (!env) return;
  if (env.OPENAI_API_KEY != null) process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
  if (env.OPENAI_MODEL != null) process.env.OPENAI_MODEL = env.OPENAI_MODEL;
  if (env.OPENAI_BASE_URL != null) process.env.OPENAI_BASE_URL = env.OPENAI_BASE_URL;
  if (env.SUPABASE_URL != null) process.env.SUPABASE_URL = env.SUPABASE_URL;
  if (env.SUPABASE_SERVICE_KEY != null) process.env.SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY;
}

export default {
  async fetch(request, env, ctx) {
    ensureZkAssetsConfigured();
    applyWorkerEnv(env);
    const apiRes = await handleFetchRequest(request);
    if (apiRes) {
      // Fire-and-forget Supabase writes triggered while handling this request are not
      // awaited (see supabaseSync.js) — without this, Cloudflare can tear down the
      // isolate as soon as the response below is returned, killing those writes
      // mid-flight on fast requests that don't otherwise keep the isolate busy.
      ctx.waitUntil(supabaseSync.waitForPending());
      return apiRes;
    }
    const pathname = new URL(request.url).pathname;
    if (pathname.includes('.bak-')) {
      return new Response('Not found', { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
