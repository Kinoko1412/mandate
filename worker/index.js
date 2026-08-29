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
  if (env.GOOGLE_CLIENT_ID != null) process.env.GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
  if (env.GOOGLE_CLIENT_SECRET != null) process.env.GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
}

/**
 * 2026-08-29：`/api/*` 全部改走這個 Durable Object，不再讓一般 Worker fetch handler
 * 直接呼叫 handleFetchRequest()——根因是 workflowStore.js／vaultKeys.js／googleTokens.js
 * 這些模組層級的記憶體狀態，在「一般 Worker」底下沒有單一 isolate 保證：Cloudflare 可能
 * 把同一個案件的連續請求分派到不同 isolate，每個 isolate 各自有一份互不相通的記憶體，
 * 造成 evidence ID 撞號、案件狀態互相看不到彼此寫入這類資料錯亂（2026-08-29 用完全依序、
 * 非平行的 4 次上傳直接在正式站重現過：3 次撞到同一個 evidenceId）。
 *
 * Durable Object 保證同一個 id 全域只會有一個實例、請求依序處理，不需要把 workflowStore
 * 等模組的 94 處呼叫全部改成 async／加鎖——把整個既有 handleFetchRequest() 原封不動搬進
 * DO 的 fetch()，讓它在這個唯一、序列化的執行環境裡跑，模組層級的 state 自然就穩定了。
 * 業務邏輯（workflowStore/workflowApi/agentAdapter/trustAdapter...）完全沒有被改動。
 *
 * 只有一個 Demo 案件，用固定名稱 idFromName('singleton') 拿到同一個 DO 實例即可，不需要
 * per-case 路由。靜態資源（HTML/CSS/JS）不經過 DO，直接由外層 Worker 的 env.ASSETS 處理，
 * 只有 pathname 以 /api/ 開頭的請求才轉發進 DO。
 */
export class WorkflowDurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    ensureZkAssetsConfigured();
    applyWorkerEnv(this.env);
    const apiRes = await handleFetchRequest(request);
    // 見下方外層 fetch() 同一段註解：避免 isolate 在回應送出後被提早回收，
    // 讓 Supabase fire-and-forget 寫入來得及完成。DO 有自己的 ctx.waitUntil。
    this.ctx.waitUntil(supabaseSync.waitForPending());
    return apiRes || new Response('Not found', { status: 404 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/api/')) {
      const id = env.WORKFLOW_DO.idFromName('singleton');
      const stub = env.WORKFLOW_DO.get(id);
      return stub.fetch(request);
    }
    if (pathname.includes('.bak-')) {
      return new Response('Not found', { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
