# SmartHub Review TODO

> 2026-07-13 專案掃描整理。此文件記錄需要後續處理的安全性、效能與架構改善項目。

## 優先級說明

- **P0**：安全風險或可能造成服務長時間卡住，應優先處理。
- **P1**：明顯的穩定性或效能風險，建議近期處理。
- **P2**：架構與維護性改善，可排入後續迭代。

## P0：安全性

### [x] 防止前端 `innerHTML` 造成 XSS

**問題**

多個 API 或設備回傳欄位直接插入 `innerHTML`。目前 alias 可由使用者寫入任意名稱，若名稱或上游資料包含 HTML/JavaScript，可能在瀏覽器執行腳本。

**主要位置**

- `server.js:572`：alias endpoint 接受 trimmed name，但沒有輸出編碼。
- `public/index.html:4626-4627`：客戶端名稱。
- `public/index.html:5680-5691`：Docker 名稱、映像、狀態與日誌按鈕參數。
- `public/index.html:5774-5779`：NAS 日誌內容、操作者與模組。
- `public/index.html:7255-7277`：AdGuard 網域與客戶端資料。

**建議處理**

1. 短期加入統一 `escapeHtml()`，所有 API、設備與使用者輸入在模板插入前編碼。
2. `onclick` 不要拼接未信任字串；改用 `data-*` 屬性與事件監聽器，參數以 `textContent` 或 DOM API 寫入。
3. 長期逐步把高風險模板改成 DOM construction，減少手動 HTML 字串。
4. 加入測試：名稱包含 `<img onerror=...>`、引號及換行時，頁面只顯示文字且不執行腳本。

## P0：上游連線穩定性

### [x] 為 UniFi Axios client 加入 timeout

**問題**

`buildUnifiClient()` 與 `buildUnifiCloudClient()` 沒有設定 Axios timeout。控制器或雲端連線卡住時，登入、趨勢取樣與 API route 可能長時間等待；背景登入的 `unifiLoginInflight` 也可能一直維持中。

**主要位置**

- `server.js:57-61`：本地 UniFi client。
- `server.js:118-124`：Site Manager cloud client。
- `server.js:96`：UniFi 登入。
- `server.js:1155-1164`：趨勢取樣。

**建議處理**

- 本地控制器 timeout 預設 10 秒，雲端 timeout 預設 8 秒。
- 支援環境變數覆寫，例如 `UNIFI_TIMEOUT_MS`、`UNIFI_CLOUD_TIMEOUT_MS`。
- 對 timeout/429 使用有限次數的退避，不要無限重試。
- 失敗時使用既有快取或 fallback，並記錄可辨識的錯誤類型。

## P1：背景工作與效能

### [x] 為 async 排程加入 in-flight guard

**問題**

多個 `setInterval` 直接呼叫 async function。當上游 API 變慢時，下一輪會在上一輪完成前啟動，可能造成請求堆積、CPU/記憶體上升，以及歷史資料重複寫入。

**主要位置**

- `server.js:1132-1133`：`notificationWatcher`、`autoDefenseSweep`。
- `server.js:1188-1192`：trend scheduler。
- `server.js:1651-1654`：NAS history sampling。
- `server.js:2282-2286`：WiiM temperature polling。
- `server.js:2645-2647`：UPS sampling。

**建議處理**

- 增加共用的 serial interval helper，或每個 job 使用 `running` flag。
- job 執行期間跳過下一輪，`finally` 必須釋放 flag。
- 為每個 job 記錄最後開始時間、完成時間、錯誤與跳過次數，方便診斷。
- 對外部服務設定單次 timeout，避免 guard 因永不返回的 Promise 長期鎖住。

### [x] 暫停背景分頁的非必要前端 polling

**問題**

`POLL_JOBS` 由 `applyPolling()` 全部啟動，隱藏分頁仍會持續輪詢；此外 `wiimPlay` 與 `wiimPlayback` 都會呼叫 `fetchWiimPlayback()`，造成重複請求。

**主要位置**

- `public/index.html:4203-4226`：polling job 定義。
- `public/index.html:4231-4235`：統一啟動 polling。
- `public/index.html:4240-4242`：目前只有 heartbeat 檢查 `document.hidden`。

**建議處理**

- `document.visibilitychange` 時暫停/恢復非必要工作。
- 依目前 active page 只啟動該頁需要的 polling。
- 移除重複的 WiiM playback job，保留一個來源。
- 若使用者同時開多個分頁，再評估用 `BroadcastChannel` 或 localStorage leader election 降低重複輪詢。

## P1：設定驗證

### [x] 為 `/api/settings` 加入欄位級限制

**問題**

目前只檢查數值是否為非負數，極小或極大的值仍會被接受，可能造成排程每秒執行、永遠不執行，或過度頻繁落盤/呼叫上游。

**主要位置**

- `server.js:1875-1877`。

**建議限制**

| 欄位 | 建議範圍 |
|---|---:|
| `trendActiveSec` | 5–3600 秒 |
| `trendIdleSec` | 60–86400 秒 |
| `reportHour` | 0–23 |
| `historyKeepDays` | 1–365 天 |
| `historyFlushMin` | 1–60 分鐘 |
| 監看器/自動防禦間隔 | 5–3600 秒 |

輸入超出範圍時應回傳 400 並指出欄位，或採明確的 clamp 策略；不要靜默接受無效設定。

## P2：架構與維護性

### [ ] 拆分 `server.js`

**問題**

`server.js` 約 2950 行，整合認證、上游 client、API routes、背景排程、通知、歷史資料與多個設備協定。任何修改都容易影響不相干功能，也缺少可獨立測試的模組邊界。

**建議拆分方向**

- `server/clients/`：UniFi、Site Manager、NAS、WiiM、UPS client。
- `server/routes/`：各設備與設定 API。
- `server/jobs/`：trend、notification、NAS、WiiM、UPS 排程。
- `server/storage/`：JSON history、settings、flush/dirty 管理。
- `server/lib/`：timeout、retry、serial job、錯誤與 log helper。

採漸進式搬移，每次只抽出一個責任，維持現有 endpoint contract。

### [ ] 拆分 `public/index.html`

**問題**

SPA 約 533 KB、超過 7300 行，HTML、CSS 與所有頁面邏輯集中在單一檔案，造成搜尋、測試與 code review 成本很高。

**建議處理順序**

1. 先抽共用安全輸出 helper 與 polling manager。
2. 再依頁面拆分 client/security/NAS/WiiM/UPS modules。
3. 將 CSS 與靜態資料移出 HTML。
4. 若依賴允許，再導入輕量 bundler；不要一次重寫整個 SPA。

## 尚未納入本次修正的 API 改善

這些不是本次掃描發現的立即故障，但應排入後續工作：

- Site Manager API 尚未處理 `nextToken` 分頁。
- 尚未針對 HTTP 429 建立統一退避策略。
- 本地 UniFi 仍以 Legacy API 為主，未來可逐步遷移到 Integration API。

## 驗證清單

- [x] `node --check server.js`
- [x] `node --check server-mock.js`
- [ ] 啟動 mock server，驗證所有主要頁面 API 可用。
- [ ] 使用惡意 alias、Docker 名稱、NAS log、AdGuard domain 驗證 XSS 防護。
- [ ] 模擬上游 timeout，確認 route 有限時返回且背景 job 不重疊。
- [ ] 隱藏/切換分頁，確認非必要 polling 暫停且恢復後狀態正確。
- [ ] 測試設定邊界值與非法值，確認不會產生每秒排程或無限等待。
