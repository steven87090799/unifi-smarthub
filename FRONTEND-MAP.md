# SmartHub Frontend Map

`public/index.html` 是巨型單檔 SPA，約 7520 行。前端任務先用這份索引定位，再讀小區段。

## Page Sections

| 行號約略 | section id | 頁面 |
|---:|---|---|
| 791 | `page-overview` | 總覽 |
| 1119 | `page-ucg` | UCG 硬體 |
| 1246 | `page-clients` | 客戶端 |
| 1303 | `page-security` | 資安 |
| 1650 | `page-wifi` | WiFi |
| 1680 | `page-cloud` | 雲端站點 |
| 1764 | `page-nas` | NAS |
| 2066 | `page-adguard` | AdGuard |
| 2127 | `page-linuxhost` | Linux 小主機 |
| 2181 | `page-tools` | 工具 |
| 2277 | `page-notify` | 通知推播 |
| 2485 | `page-settings` | 設定 |
| 2878 | `page-wiim` | WiiM |
| 3585 | `page-ups` | UPS |

## Script Anchors

| 行號約略 | 名稱 | 用途 |
|---:|---|---|
| 4010 | `renderPinned()` | 總覽釘選區 |
| 4090 | `initNasHeroChart()` | NAS hero 圖表 |
| 4107 | `initUpsHeroChart()` | UPS hero 圖表 |
| 4241 | `POLL_JOBS` | 全站前端輪詢設定（含 System Diagnostics） |
| 4269 | `applyPolling()` | 套用輪詢 interval |
| 4348 | `initChart()` | UCG 即時硬體圖 |
| 4385 | `initTrendChart()` | 趨勢圖 |
| 4439 | `fetchTrends()` | 趨勢資料 |
| 4522 | `fetchHardware()` | UCG 硬體 |
| 4645 | `fetchClients()` | 客戶端 |
| 4863 | `fetchWiFiNetworks()` | WiFi |
| 4868-4979 | `fetchCloud*()` | Site Manager |
| 5023 | `renderThreatTable()` | 資安事件表 |
| 5123 | `updateSecurityAnalytics()` | 資安分析/評分 |
| 5228 | `fetchThreats()` | 威脅事件 |
| 5329 | `fetchNas()` | NAS 基本資訊 |
| 5549 | `initNasCharts()` | NAS 圖表初始化 |
| 5596-5843 | `fetchNas*()` | NAS 進階/告警/Docker |
| 5984 | `fetchNotifSettings()` | 通知設定 |
| 6213 | `fetchSystemStatus()` | 設定頁 System Diagnostics / Active Issues |
| 6263 | `renderPollConfig()` | 設定頁輪詢表 |
| 6283 | `fetchAppSettings()` | 後端設定 |
| 6353 | `fetchConnections()` | 連線設定 |
| 6471 | `initWiimPage()` | WiiM 頁初始化 |
| 6530 | `fetchWiimPlayback()` | WiiM 播放狀態 |
| 6619 | `fetchWiimSystem()` | WiiM 系統資訊 |
| 7160 | `fetchUcgHist()` | UCG 歷史與 spikes |
| 7255 | `fetchUps*()` | UPS 圖表/事件 |
| 7395 | `fetchAdguard*()` | AdGuard |
| 7456 | `fetchLinux*()` | Linux 小主機 |

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
