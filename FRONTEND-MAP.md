# SmartHub Frontend Map

`public/index.html` 仍是大型單檔 SPA。前端任務先用這份 symbol/section 索引定位，再讀小區段；歷史行號只作搜尋提示，不是契約。

## Page Sections

| 行號約略 | section id | 頁面 |
|---:|---|---|
| 1093 | `page-overview` | 總覽 |
| 1421 | `page-ucg` | UCG 硬體 |
| 1548 | `page-clients` | 客戶端 |
| 1605 | `page-security` | 資安 |
| 1952 | `page-wifi` | WiFi |
| 1982 | `page-cloud` | 雲端站點 |
| 2066 | `page-nas` | NAS |
| 2368 | `page-adguard` | AdGuard |
| 2429 | `page-linuxhost` | Linux 小主機 |
| 2483 | `page-tools` | 工具 |
| 2579 | `page-notify` | 通知推播 |
| 2830 | `page-settings` | 設定 |
| 3232 | `page-wiim` | WiiM |
| 3939 | `page-ups` | UPS |

## Shared UI / Chart System

| 行號約略 | 名稱 | 用途 |
|---:|---|---|
| 588 | `SmartHub UI System 2026` | Design tokens、卡片/表單/表格/狀態/Loading/Empty/Error/Responsive/Reduced Motion |
| 4463 | `downsampleRows()` | 桌面 180、手機 72 點的多欄位峰值保留視覺降採樣；統計仍用原始資料 |
| 4497 | `uiExternalTooltip()` | 共用分組 Tooltip，最多顯示 4 列摘要 |
| 4542 | `showChartDetail()` | 點擊資料點後固定顯示完整明細 |
| 4561 | `renderHtmlChartLegend()` | 可鍵盤操作的 HTML Legend Toggle |
| 4594 | `smartChartUxPlugin` | Crosshair、Active Point、ARIA、動態 Tick、Chart loading |
| 4678 | `updateChartWithEntrance()` | 首次載入、時間範圍切換與重新進入頁面時播放漸進式圖表動畫；背景輪詢不動畫 |
| 4767 | `initUiSystem()` | 表格捲動、互動卡鍵盤操作、Loading/Empty/Error observer、Modal Escape |

## Script Anchors

| 行號約略 | 名稱 | 用途 |
|---:|---|---|
| 4364 | `renderPinned()` | 總覽釘選區；非總覽或背景分頁停止同步 |
| 4913 | `POLL_JOBS` | 全站前端輪詢設定（含 System Diagnostics）；總覽與設備頁可見時套用 3 秒有效間隔 |
| 4942 | `applyPolling()` | 套用輪詢 interval，避免同一工作重疊執行 |
| 5000 | `initOverviewFlipNumbers()` | 總覽大型數字變更時播放向上翻頁動畫 |
| 5021 | `initChart()` | UCG 即時硬體圖 |
| 5164 | `initTrendChart()` | 趨勢圖；短暫來源缺值可跨點連續呈現 |
| 5219 | `fetchTrends()` | 趨勢資料 + 降採樣；略過不完整合併樣本並顯示資料品質提示 |
| 5196 | `fetchHardware()` | UCG 硬體 |
| 5319 | `fetchClients()` | 客戶端；表格列含鍵盤/ARIA 操作 |
| 5550 | `fetchWiFiNetworks()` | WiFi |
| 5604-5695 | `fetchCloud*()` | Site Manager |
| 5759 | `renderThreatTable()` / `fetchThreatBlocks()` | 資安事件表；管理員臨時公網 IPv4 封鎖、到期與同步狀態 |
| 5859 | `updateSecurityAnalytics()` | 資安分析/評分 |
| 5964 | `fetchThreats()` | 威脅事件 |
| 6100 | `updateGuestQR()` | 透過同源 admin-only API 產生 QR blob；不得把 SSID/密碼送往第三方 |
| 6065 | `fetchNas()` | NAS 基本資訊 |
| 6296 | `initNasCharts()` | NAS 圖表初始化 |
| 6343-6754 | `fetchNas*()` | NAS 進階/告警/Docker |
| 6754 | `fetchNotifSettings()` | 通知設定 |
| 6940 | `fetchSystemStatus()` | 設定頁 System Diagnostics / Active Issues |
| 6990 | `renderPollConfig()` | 設定頁輪詢表 |
| 7010 | `fetchAppSettings()` | 後端設定 |
| 7080 | `fetchConnections()` | 連線設定 |
| settings | `fetchConfigBackupStatus()` / `downloadConfigBackup()` / `stageConfigRestore()` | admin-only 安全備份、明確確認、staged restore 狀態 |
| settings | `conn-ADGUARD_*` | AdGuard HTTPS origin、legacy host/port、遠端 HTTP opt-in、TLS 驗證與自簽 CA 設定；密碼沿用 secret-set/pending restart 顯示契約 |
| 7228 | `initWiimPage()` | WiiM 頁初始化 |
| 7287 | `fetchWiimPlayback()` | WiiM 播放狀態 |
| 7376 | `fetchWiimSystem()` | WiiM 系統資訊 |
| 7553 | `renderWiimChart()` | WiiM 圖表、平滑與降採樣 |
| 7920 | `fetchUcgHist()` | UCG 歷史與 spikes |
| 7992 | `initUpsCharts()` | UPS 圖表 |
| 8016 | `fetchUps()` | UPS 狀態/歷史/事件 + 降採樣 |
| 8158 | `fetchAdguard*()` | AdGuard |
| AdGuard | `fetchAdguardServicePolicies()` / `saveAdguardServicePolicy()` / `removeAdguardServicePolicy()` | admin-only 裝置 IP/MAC、YouTube/TikTok/Gaming、IANA timezone、每日 allow window、同步錯誤/重試與 baseline restore |
| Notify | `public/js/web-push.js` | `fetchWebPushState()` / `subscribeWebPush()` / `unsubscribeWebPush()`；admin user gesture、permission denied、VAPID public key、目前瀏覽器訂閱與 server subscription count；Web Push 是額外 fan-out |
| 8219 | `fetchLinux*()` | Linux 小主機 |

## 前端資產

- `public/assets/tailwind.css`: `tailwindcss@3.4.19` 的 deterministic production output
- `frontend/tailwind.input.css` + `tailwind.config.cjs`: CSS 建置來源；掃描 `public/index.html` 與 `public/js/**/*.js`，修改 class 後跑 `npm run build:css`
- `public/js/web-push.js`: 第一個獨立功能模組；只公開三個明確的 `window` UI 入口，保留既有 inline 初始化/輪詢呼叫契約
- Chart.js、D3、TopoJSON、world-atlas 由 `/vendor/<package>/<exact-version>/...` 同源提供，版本由 `package-lock.json` 與 `server/routes/frontend-asset-routes.js` 約束
- `/sw.js` 由 `server/services/pwa-service-worker.js` 產生，production/mock 共用 cache/push/click 行為；API/health 不進 cache，push click 只接受 same-origin path

## 常用定位

```bash
rg -n "page-nas|fetchNas|initNasCharts|nas-" public/index.html
sed -n '1764,2065p' public/index.html

rg -n "POLL_JOBS|applyPolling|renderPollConfig" public/index.html
sed -n '4203,4255p' public/index.html
```

## 注意

- 新卡片通常放進現有 `data-drag` 容器，避免破壞版面編輯。
- 不要整檔讀 `public/index.html`；先用 `rg` 找 id/function，再 `sed -n` 讀附近 80-200 行。
- 若改 CSS/主題，先搜尋 `<style>` 與 class 使用位置，避免全檔掃描。
