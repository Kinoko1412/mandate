# Workers 相容性驗證（可重跑）

背景與三個真實踩到的問題見 `../README.md`「Cloudflare Workers 相容性」一節。這個資料夾是
拿來重新驗證的最小專案，不是產品程式碼的一部分（`worker/index.js` 才是真正的部署入口）。

## 怎麼跑

```bash
cd mandate
npx wrangler dev --config circuits/workers-compat-check/wrangler.toml --port 18787 --local
# 另開一個終端機：
curl http://127.0.0.1:18787/
```

預期輸出（`passed: true`）：

```json
{
  "ok": true,
  "totalScaled": 180000000,
  "compliant": true,
  "verifyValidProof": true,
  "verifyTamperedProof": false,
  "passed": true
}
```

這是在真正的 `workerd` 引擎裡（不是 mock/模擬）完整跑一次 `groth16.fullProve()` + 兩次
`groth16.verify()`（一次合法、一次故意竄改 publicSignals），2026-08-25 凌晨執行過並確認
`passed: true`。
