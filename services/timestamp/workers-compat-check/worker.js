// services/timestamp/workers-compat-check/worker.js — 可重跑的 Cloudflare Workers 相容性驗證。
// 用 `npx wrangler dev --config services/timestamp/workers-compat-check/wrangler.toml` 啟動後
// 打 `GET /`,應該回傳對真實 DigiCert TSA 送出請求、取得時戳、驗證簽章都成功。
// 跟 circuits/workers-compat-check 不同:RFC 3161 不需要 WASM 動態編譯,理論上應該直接能跑,
// 這支就是驗證這個理論是否成立(不能只憑套件說明假設,見 docs/trust/RFC3161_TIMESTAMP_PLAN.md 第4節)。

import { requestTimestamp, verifyTimestamp } from '../index.js';

export default {
  async fetch() {
    const steps = [];
    try {
      steps.push('module loaded');
      const payload = `workers-compat-check-${Date.now()}`;

      const issued = await requestTimestamp(payload);
      steps.push(`requestTimestamp status=${issued.status}`);
      if (issued.status !== 'ok') {
        return Response.json({ ok: false, steps, issued }, { status: 500 });
      }

      const verified = await verifyTimestamp({ tsToken: issued.tsToken, payload });
      steps.push(`verifyTimestamp valid=${verified.valid}`);

      const tampered = await verifyTimestamp({ tsToken: issued.tsToken, payload: payload + '-tampered' });
      steps.push(`tampered verify valid=${tampered.valid}(應為 false)`);

      const passed = verified.valid === true && tampered.valid === false;
      return Response.json({ ok: true, steps, tsaUrl: issued.tsaUrl, verified, tampered, passed });
    } catch (err) {
      return Response.json({ ok: false, steps, error: err.message, stack: err.stack }, { status: 500 });
    }
  },
};
