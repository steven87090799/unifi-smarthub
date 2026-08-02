# SmartHub 前端地圖

`public/index.html` 是 SPA 的純 HTML shell；Dashboard 行為在 `public/js/app.js`，啟動主題／Service Worker 在 `public/js/bootstrap.js`，安全的動態操作分派在 `public/js/action-dispatcher.js`。HTML 不含 inline script 或 inline event handler。

## 頁面

| section id | 頁面 | section id | 頁面 |
|---|---|---|---|
| `page-overview` | 總覽 | `page-ucg` | UCG |
| `page-clients` | 客戶端 | `page-security` | 資安 |
| `page-wifi` | WiFi | `page-cloud` | 雲端站點 |
| `page-nas` | NAS | `page-wiim` | WiiM |
| `page-ups` | UPS | `page-adguard` | AdGuard |
| `page-linuxhost` | Linux | `page-tools` | 工具 |
| `page-notify` | 通知 | `page-settings` | 設定 |

## 更新與圖表

| 名稱 | 用途 |
|---|---|
| `POLL_JOBS` | 全站輪詢設定 |
| `applyPolling()` | 防止同一工作重疊 |
| `/api/heartbeat` | 維持目前頁面活動 scope |
| `downsampleRows()` | 桌面 180／手機 72 點峰值保留降採樣 |
| `updateChartWithEntrance()` | 首載／換範圍動畫；背景輪詢不動畫 |
| `uiExternalTooltip()` | 共用圖表摘要 |
| `showChartDetail()` | 固定顯示資料點明細 |
| `renderHtmlChartLegend()` | 可鍵盤操作圖例 |
| `initUiSystem()` | 表格、卡片、Modal、Loading／Empty／Error |
| `hydratePage()`／`frontend-lifecycle.js` | 首次頁面 hydration、per-job 完成集、重試與 in-flight generation 去重 |
| `renderPinned()`／`updatePinnedMirror()` | 釘選卡片與 change-driven、inert 的 MutationObserver 鏡像 |

初始啟動只讀取必要的設定、健康與重大事件；`PAGE_HYDRATION` 由 `frontend-lifecycle.js` 以每頁 completed job set 載入，失敗只重試失敗 job，並以 generation 丟棄過期結果。hydration pending 不會阻擋 heartbeat／重大事件 common jobs。總覽或目前裝置頁可見時，相關一般資料與後端取樣由設定值驅動，預設為 5 秒；UPS 狀態獨立預設 3 秒。UCG 頁的 UniFi 裝置卡每 5 秒只讀 snapshot／history，並送出獨立 `unifi-device-telemetry` scope；真正 Controller／Device SSH 取樣預設為可見 60 秒、閒置 300 秒。heartbeat 只送 `PAGE_ACTIVITY_SCOPES` 的實際 scope、不送 `general`，並帶 per-tab monotonic sequence。切頁、背景分頁或租約到期後立即回到低頻。
UPS 歷史與 PPB 事件各預設 10 秒；完整且可調整的頻率見 [POLLING-INTERVALS.md](../operations/POLLING-INTERVALS.md)。

## 主要功能錨點

| 名稱 | 用途 |
|---|---|
| `renderPinned()` | 總覽釘選卡片；離開／hidden 時 teardown observer，返回 Overview 再同步 |
| `fetchTrends()` | 趨勢與資料品質提示 |
| `fetchHardware()`／`fetchClients()`／`fetchWiFiNetworks()` | UCG／客戶端／WiFi |
| `fetchUnifiDeviceTelemetry()` | UniFi 裝置 snapshot／history、stale／unsupported 顯示；所有上游字串先 escape |
| `fetchCloud*()` | Site Manager |
| `fetchThreats()`／`fetchThreatBlocks()` | 威脅與暫時封鎖 |
| `updateGuestQR()` | 同源 admin-only WiFi QR |
| `fetchNas*()` | NAS、Docker、告警與歷史 |
| `fetchWiim*()`／`renderWiimChart()` | WiiM 播放、系統與溫度 |
| `fetchUps()`／`initUpsCharts()` | UPS 狀態、歷史與事件 |
| `fetchAdguard*()` | AdGuard 與裝置政策 |
| `fetchLinux*()` | Linux 主機 |
| `fetchNotifSettings()` | 通知設定 |
| `fetchSystemStatus()` | System Diagnostics／Active Issues |
| `fetchConnections()` | 連線設定與 restart-required 狀態 |
| `downloadConfigBackup()`／`stageConfigRestore()` | 安全備份與分階段還原 |

## 獨立資產

- `public/login.html`, `public/assets/login.css`, `public/js/login.js`：Session 登入與一次性匿名核心快照。
- `public/js/bootstrap.js`：首屏主題與 Service Worker 註冊。
- `public/js/action-dispatcher.js`：以 `data-action` 與 escaped data 分派動態操作，readonly 不執行 admin action。
- `public/js/app.js`：Dashboard 輪詢、渲染、設定與互動主程式。
- `public/js/frontend-lifecycle.js`：可測試的 hydration、page-scoped resource 與 observer lifecycle primitive。
- `public/js/web-push.js`：瀏覽器訂閱／取消訂閱；Web Push 是額外通知 fan-out。
- `public/assets/tailwind.css`：由 `npm run build:css` 產生；`npm run check:css` 驗證。
- Chart.js、D3、TopoJSON、world-atlas：由 `/vendor/<package>/<version>/...` 同源提供。
- `/sw.js`：由後端產生；API／health 不進 cache，通知點擊只接受 same-origin path。
- UniFi 遙測沿用已在 PWA shell 的 `/js/app.js`，沒有新增 executable asset；cache name 仍由 build revision 版本化。
- CSP `script-src 'self'`，不含 `unsafe-inline`／`unsafe-eval`；新增 executable asset 時必須同步 CSP contract 與 PWA shell。

## 修改注意

- 新卡片沿用現有 `data-drag` 容器與 UI tokens。
- 寫入控制必須同時處理 readonly、CSRF、錯誤與確認狀態。
- 修改 Tailwind class 後更新 CSS 產物。
- 新前端 API／設定欄位同步 production、mock 與契約測試。

```bash
rg -n "page-nas" public/index.html
rg -n "fetchNas|initNasCharts|POLL_JOBS|applyPolling|sendHeartbeat" public/js/app.js
```
