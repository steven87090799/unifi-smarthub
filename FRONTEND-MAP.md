# SmartHub 前端地圖

`public/index.html` 是大型 SPA shell。先用本檔找 section／function，再讀附近片段；登入頁與 Web Push 已拆成獨立資產。

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

總覽或目前裝置頁可見時，相關前端資料與後端取樣使用 3 秒節奏；但 UniFi Device telemetry API 只讀專用 snapshot，Controller/Device SSH 仍固定用 60/300 秒 sampler。Snapshot 過期時，卡片改為「上次成功溫度／資料已過期」，不把最後值標成目前溫度。切頁、背景分頁或租約到期後立即回到低頻。
大型歷史查詢不跟著全部加速：UPS/NAS/UCG 歷史圖使用 10 秒以上節奏，完整表見 `docs/operations/POLLING-INTERVALS.md`。

## 主要功能錨點

| 名稱 | 用途 |
|---|---|
| `renderPinned()` | 總覽釘選卡片 |
| `fetchTrends()` | 趨勢與資料品質提示 |
| `fetchHardware()`／`fetchUnifiDeviceTelemetry()`／`fetchClients()`／`fetchWiFiNetworks()` | UCG、受管理設備 CPU／真實溫度、客戶端／WiFi |
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
- `public/js/web-push.js`：瀏覽器訂閱／取消訂閱；Web Push 是額外通知 fan-out。
- `public/assets/tailwind.css`：由 `npm run build:css` 產生；`npm run check:css` 驗證。
- Chart.js、D3、TopoJSON、world-atlas：由 `/vendor/<package>/<version>/...` 同源提供。
- `/sw.js`：由後端產生；API／health 不進 cache，通知點擊只接受 same-origin path。

## 修改注意

- 新卡片沿用現有 `data-drag` 容器與 UI tokens。
- 寫入控制必須同時處理 readonly、CSRF、錯誤與確認狀態。
- 修改 Tailwind class 後更新 CSS 產物。
- 新前端 API／設定欄位同步 production、mock 與契約測試。

```bash
rg -n "page-nas|fetchNas|initNasCharts" public/index.html
rg -n "POLL_JOBS|applyPolling|heartbeat" public/index.html
```
