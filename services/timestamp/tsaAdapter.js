'use strict';

/**
 * services/timestamp/tsaAdapter — 可替換的 TSA(時間戳記機構)端點設定。
 *
 * 選型依據:`docs/trust/RFC3161_TIMESTAMP_PLAN.md` 第2節 + `實驗記錄/RFC3161_TSA連通性測試_20260911.md`。
 * 2026-09-11～12 實測結論(含一次更正,細節見實驗記錄檔):
 *   - 國內選項(中華電信 eTSCA、TWCA)現在都無法免費/免帳號立即使用,故建置階段一律用公開 TSA。
 *   - DigiCert(`timestamp.digicert.com`)、Sectigo、GlobalSign 三家的回應簽章鏈皆驗證通過,且鏈到
 *     公開信任的 WebPKI 根;FreeTSA 的根是自我簽發,信任基礎較弱。
 *   - GlobalSign 的簽發憑證名稱寫明「for CodeSign」,場景疑慮較大,故排除。
 *   - DigiCert 與 Sectigo 命名皆通用,DigiCert 延遲較低(見實驗記錄計時數據),選為預設。
 *   - 2026-09-12 額外查證使用條款:DigiCert 全域(非 DigiCert Europe 子公司)Certificate Policy 未限制
 *     時戳用途、未排除公開/匿名使用;Sectigo 官方時戳服務頁面明確標示支援「code and documents」,
 *     非僅限程式碼簽章,並建議腳本化呼叫間隔 >= 15 秒,已記錄進 `rateLimitHintMs`。
 *
 * 正式導入路徑:若之後採購 eTSCA 或 TWCA 的正式服務,直接在這裡新增一個 profile、把
 * `DEFAULT_PROFILE_ID` 改過去即可,呼叫端(`services/timestamp/index.js` 及其使用者)完全不用改。
 */

const TSA_PROFILES = Object.freeze({
  digicert: Object.freeze({
    id: 'digicert',
    label: 'DigiCert(公開,預設)',
    url: 'http://timestamp.digicert.com',
    rateLimitHintMs: null, // 查證時未找到官方公告的速率限制;實作時建議先低頻(每分鐘1-2次)觀察
    notes:
      '2026-09-12 已驗證簽章鏈(鏈到系統信任的 WebPKI 根)與使用條款(DigiCert 全域 CP 未限制時戳用途)。',
  }),
  sectigo: Object.freeze({
    id: 'sectigo',
    label: 'Sectigo(公開,備援)',
    url: 'http://timestamp.sectigo.com',
    rateLimitHintMs: 15000, // 官方頁面建議腳本化呼叫間隔 >= 15 秒
    notes: '2026-09-12 已驗證簽章鏈與使用條款(官方頁面明確支援 code and documents,非僅限程式碼簽章)。',
  }),
  globalsign: Object.freeze({
    id: 'globalsign',
    label: 'GlobalSign(公開,次備援)',
    url: 'http://timestamp.globalsign.com/tsa/r6advanced1',
    rateLimitHintMs: null,
    notes: '簽發憑證名稱寫明「for CodeSign」,場景疑慮較大,未查證使用條款細節,僅列為次備援。',
  }),
  freetsa: Object.freeze({
    id: 'freetsa',
    label: 'FreeTSA(公開,末位備援)',
    url: 'https://freetsa.org/tsr',
    rateLimitHintMs: null,
    notes: '根憑證為自我簽發,不在系統/瀏覽器內建信任清單,信任基礎弱於其餘三者,僅列為末位備援。',
  }),
});

const DEFAULT_PROFILE_ID = 'digicert';

function getTsaProfile(profileId) {
  const id = profileId || DEFAULT_PROFILE_ID;
  const profile = TSA_PROFILES[id];
  if (!profile) {
    throw new TypeError(`未知的 TSA profile:${id}(可用:${Object.keys(TSA_PROFILES).join(', ')})`);
  }
  return profile;
}

function getDefaultTsaUrl() {
  return TSA_PROFILES[DEFAULT_PROFILE_ID].url;
}

module.exports = { TSA_PROFILES, DEFAULT_PROFILE_ID, getTsaProfile, getDefaultTsaUrl };
