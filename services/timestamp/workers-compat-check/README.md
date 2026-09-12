# Workers 相容性驗證(可重跑)

背景見 `../../../docs/trust/RFC3161_TIMESTAMP_PLAN.md` 第4節。這個資料夾是拿來重新驗證的
最小專案,不是產品程式碼的一部分。

## 怎麼跑

```bash
cd mandate
npx wrangler dev --config services/timestamp/workers-compat-check/wrangler.toml --port 18788 --local
# 另開一個終端機:
curl http://127.0.0.1:18788/
```

預期輸出(`passed: true`):

```json
{
  "ok": true,
  "steps": ["module loaded", "requestTimestamp status=ok", "verifyTimestamp valid=true", "tampered verify valid=false(應為 false)"],
  "tsaUrl": "http://timestamp.digicert.com",
  "verified": { "valid": true, "genTime": "...", "reasonCodes": [] },
  "tampered": { "valid": false, "genTime": "...", "reasonCodes": ["..."] },
  "passed": true
}
```

**2026-09-12 已在真正的 Cloudflare Workers runtime(`wrangler dev --local`,workerd 引擎)裡
跑通:真實對 `timestamp.digicert.com` 送出 RFC 3161 請求、取得時戳、驗證簽章、且正確拒絕竄改過
的 payload,結果 `passed: true`。** 跟 ZK 電路(`circuits/workers-compat-check/`)當時踩到的
WASM 動態編譯問題不同,`services/timestamp/` 完全不需要 WASM——只用到 `fetch`(內建)、
WebCrypto `crypto.subtle`(內建)、以及純 JS 的 ASN.1/CMS 函式庫(`@peculiar/asn1-*`、
`asn1js`、`pkijs`),這支測試確認了這個理論成立,沒有額外的相容性坑要處理。

依賴 `nodejs_compat` compatibility flag(專案 `wrangler.toml` 已經全域開啟,這支的
`wrangler.toml` 另外重複宣告一次是為了讓這個獨立最小專案可以脫離主專案設定單獨重跑)。
