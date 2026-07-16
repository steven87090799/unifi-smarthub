# SmartHub Frontend Map

`public/index.html` 仍是大型 SPA shell。前端任務先用這份 symbol/section 索引定位，再讀小區段；不要保存會隨功能漂移的行號。

## Page Sections

| section id | 頁面 |
|---|---|
| `page-overview` | 總覽 |
| `page-ucg` | UCG 硬體 |
| `page-clients` | 客戶端 |
| `page-security` | 資安 |
| `page-wifi` | WiFi |
| `page-cloud` | 雲端站點 |
| `page-nas` | NAS |
| `page-adguard` | AdGuard |
| `page-linuxhost` | Linux 小主機 |
| `page-tools` | 工具 |
| `page-notify` | 通知推播 |
| `page-settings` | 設定 |
| `page-wiim` | WiiM |
| `page-ups` | UPS |

## Shared UI / Chart System

| 名稱 | 用途 |
|---|---|
| `SmartHub UI System 2026` | Design tokens、卡片/表單/表格/狀態/Loading/Empty/Error/Responsive/Reduced Motion |
| `downsampleRows()` | 桌面 180、手機 72 點的多欄位峰值保留視覺降採樣；統計仍用原始資料 |
| `uiExternalTooltip()` | 共用分組 Tooltip，最多顯示 4 列摘要 |
| `showChartDetail()` | 點擊資料點後固定顯示完整明細 |
| `renderHtmlChartLegend()` | 可鍵盤操作的 HTML Legend Toggle |
| `smartChartUxPlugin` | Crosshair、Active Point、ARIA、動態 Tick、Chart loading |
| `updateChartWithEntrance()` | 首次載入、時間範圍切換與重新進入頁面時播放漸進式圖表動畫；背景輪詢不動畫 |
| `initUiSystem()` | 表格捲動、互動卡鍵盤操作、Loading/Empty/Error observer、Modal Escape |

## Script Anchors

| 名稱 | 用途 |
|---|---|
| `renderPinned()` | 總覽釘選區；非總覽或背景分頁停止同步 |
| `POLL_JOBS` | 全站前端輪詢設定（含 System Diagnostics）；總覽與設備頁可見時套用 3 秒有效間隔 |
| `applyPolling()` | 套用輪詢 interval，避免同一工作重疊執行 |
| `initOverviewFlipNumbers()` | 總覽大型數字變更時播放向上翻頁動畫 |
| `initChart()` | UCG 即時硬體圖 |
| `initTrendChart()` | 趨勢圖；短暫來源缺值可跨點連續呈現 |
| `fetchTrends()` | 趨勢資料 + 降採樣；略過不完整合併樣本並顯示資料品質提示 |
| `fetchHardware()` | UCG 硬體 |
| `fetchClients()` | 客戶端；表格列含鍵盤/ARIA 操作 |
| `fetchWiFiNetworks()` | WiFi |
| `fetchCloud*()` | Site Manager |
| `renderThreatTable()` / `fetchThreatBlocks()` | 資安事件表；管理員臨時公網 IPv4 封鎖、到期與同步狀態 |
| `updateSecurityAnalytics()` | 資安分析/評分 |
| `fetchThreats()` | 威脅事件 |
| `updateGuestQR()` | 透過同源 admin-only API 產生 QR blob；不得把 SSID/密碼送往第三方 |
| `fetchNas()` | NAS 基本資訊 |
| `initNasCharts()` | NAS 圖表初始化 |
| `fetchNas*()` | NAS 進階/告警/Docker |
| `fetchNotifSettings()` | 通知設定 |
| `fetchSystemStatus()` | 設定頁 System Diagnostics / Active Issues |
| `renderPollConfig()` | 設定頁輪詢表 |
| `fetchAppSettings()` | 後端設定 |
| `fetchConnections()` | 連線設定 |
| `fetchConfigBackupStatus()` / `downloadConfigBackup()` / `stageConfigRestore()` | admin-only 安全備份、明確確認、staged restore 狀態 |
| `conn-ADGUARD_*` | AdGuard HTTPS origin、legacy host/port、遠端 HTTP opt-in、TLS 驗證與自簽 CA 設定；密碼沿用 secret-set/pending restart 顯示契約 |
| `initWiimPage()` | WiiM 頁初始化 |
| `fetchWiimPlayback()` | WiiM 播放狀態 |
| `fetchWiimSystem()` | WiiM 系統資訊 |
| `renderWiimChart()` | WiiM 圖表、平滑與降採樣 |
| `fetchUcgHist()` | UCG 歷史與 spikes |
| `initUpsCharts()` | UPS 圖表 |
| `fetchUps()` | UPS 狀態/歷史/事件 + 降採樣 |
| `fetchAdguard*()` | AdGuard |
| `fetchAdguardServicePolicies()` / `saveAdguardServicePolicy()` / `removeAdguardServicePolicy()` | admin-only 裝置 IP/MAC、YouTube/TikTok/Gaming、IANA timezone、每日 allow window、同步錯誤/重試與 baseline restore |
| `public/js/web-push.js` | `fetchWebPushState()` / `subscribeWebPush()` / `unsubscribeWebPush()`；admin user gesture、permission denied、VAPID public key、目前瀏覽器訂閱與 server subscription count；Web Push 是額外 fan-out |
| `fetchLinux*()` | Linux 小主機 |

## 前端資產

- `public/assets/tailwind.css`: `tailwindcss@3.4.19` 的 deterministic production output
- `frontend/tailwind.input.css` + `tailwind.config.cjs`: CSS 建置來源；掃描 `public/index.html` 與 `public/js/**/*.js`，修改 class 後跑 `npm run build:css`
- `public/login.html` + `public/assets/login.css` + `public/js/login.js`: 獨立登入介面；Liquid Glass、響應式、表單狀態、Session 登入與 reduced-motion，不依賴 Tailwind／Canvas
- `public/js/web-push.js`: 第一個獨立功能模組；只公開三個明確的 `window` UI 入口，保留既有 inline 初始化/輪詢呼叫契約
- Chart.js、D3、TopoJSON、world-atlas 由 `/vendor/<package>/<exact-version>/...` 同源提供，版本由 `package-lock.json` 與 `server/routes/frontend-asset-routes.js` 約束
- `/sw.js` 由 `server/services/pwa-service-worker.js` 產生，production/mock 共用 cache/push/click 行為；API/health 不進 cache，push click 只接受 same-origin path

## 常用定位

```bash
rg -n "page-nas|fetchNas|initNasCharts|nas-" public/index.html

rg -n "POLL_JOBS|applyPolling|renderPollConfig" public/index.html
```

## 注意

- 新卡片通常放進現有 `data-drag` 容器，避免破壞版面編輯。
- 不要整檔讀 `public/index.html`；先用 `rg` 找 id/function，再 `sed -n` 讀附近 80-200 行。
- 若改 CSS/主題，先搜尋 `<style>` 與 class 使用位置，避免全檔掃描。
