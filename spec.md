# SmartHub 專案技術規格書與 AI 導引指南 (spec.md)

本文件專為「開發者」與「AI 協作助手（AI Coding Assistants）」所設計。其核心目標在於提供一份高密度的結構化專案規格，讓未來讀取本專案的 AI 能夠在數秒內精確掌握整個系統的結構原理、模組邊界、資料流向、全量 API 端點與程式碼規範，而無須逐行解析原始碼。

---

## 1. 完整專案結構 (Complete Directory Tree)

以下為 `unifi-smarthub` 的完整檔案結構及各核心模組的職責劃分：

```text
unifi-smarthub/
├── .dockerignore                 # 排除不需打包進 Docker 映像檔的檔案與資料夾 (如 node_modules、data 磁碟區)
├── .env                          # 本地開發與正式環境環境變數設定檔 (機密金鑰，如 SSH 密碼、API Key 不進 Git)
├── .env.example                  # 環境變數範本檔，明列 UniFi、UGREEN 及 WiiM 所需變數與連接 IP 預設值
├── .gitignore                    # Git 忽略設定，強制排除 node_modules、.env 與本地 data JSON
├── CLAUDE.md                     # 專案簡要架構、端點對照與快速變更指令紀錄
├── Dockerfile                    # 使用 node:20-alpine 輕量映像檔，採非 root 安全執行與 tini 監護 (健康檢查 /healthz)
├── README.md                     # 使用者導向的專案介紹、部署步驟、Docker Compose 安裝與故障排除指引
├── cyberpower-ups-api.md         # CyberPower UPS 狀態監控與 IOKit 診斷協定參考文件
├── docker-compose.yml            # 容器編排檔，掛載具名 Volume 作資料持久化並限制記憶體上限為 256MB
├── package-lock.json             # 鎖定 npm 依賴套件之確切版本與二進位雜湊值
├── package.json                  # 定義專案中繼資料、啟動腳本與生產依賴 (express, axios, ssh2, dotenv, cors)
├── server.js                     # [核心後端] 正式 Express 主程式，包含 API 路由、背景輪詢、快取與定時報表
├── server-mock.js                # [模擬後端] 開發與預覽專案專用的無依賴模擬伺服器，模擬真實 API 回應
├── ugreen-nas-api.md             # UGREEN UGOS Pro NAS 原生 API 的逆向工程與欄位解析參考手冊
├── unifi-network-api.md          # UniFi Network Controller (Legacy) 與 Site Manager API 規格文件
├── wiim-amp-api.md               # WiiM Amp HTTP API 與系統協定高密度參考規格
├── wiim_spec.md                  # 本專案整合 WiiM APIs 頻率、端點 payload 與欄位定義的專屬規格書
├── data/                         # [資料庫/持久化] 存放本地 JSON 格式資料的實體資料夾 (Docker 掛載點)
│   ├── trend-history.json        # 歷史趨勢遙測紀錄 (保留 7 天，上限 9,999 筆)
│   ├── block-history.json        # 前端控制台下達的客戶端封鎖/解鎖歷史日誌 (上限 200 筆)
│   ├── security-settings.json    # 資安狀態設定持久化 (如自動防禦聯動 autoDefense 開關)
│   └── app-settings.json         # 伺服器取樣與監測背景排程之時間間隔設定檔 (排程自適應設定)
└── public/                       # [前端靜態資源]
    └── index.html                # [核心前端] 單一網頁應用程式 (SPA)，包含所有分頁、CSS 樣式與 Chart.js / D3 邏輯
```

---

## 2. 核心架構與設計原理 (Architecture & Core Principles)

### 2.1 安全隔離與代理設計 (Security Proxy Design)
系統嚴格遵守「前端無秘密」的安全原則。所有對外部系統的身份認證與通訊均由 Node.js 後端統一處理：
* **UniFi Controller 本地認證**：調用 `/api/auth/login` 獲取以 Cookie 為基礎的 Session 金鑰。後端利用 `getLocalSession()` 進行管理，將 Cookie 快取 15 分鐘，過期自動重新登入，避免頻繁呼叫上游造成效能瓶頸。
* **UniFi 官方雲端 API**：使用 HTTP 標頭 `X-API-KEY` 進行認證，金鑰存在 `.env` 中，前端發送請求至 `/api/cloud/*` 由 `unifiCloudClient` 轉發。
* **UGREEN UGOS Pro 認證**：實作了兩階段認證流程。先調用 `/ugreen/v1/verify/rsa_public_key` 獲取公鑰，隨後使用 **RSA PKCS1v15** 加密演算法將密碼加密並以 Base64 編碼，最後發送 `POST /ugreen/v1/verify/login` 取回 JWT Token。Token 緩存在記憶體中 12 小時。

### 2.2 背景取樣與自適應調度 (Background Sampling & trendScheduler)
為了解決無人使用網頁時後端仍持續輪詢上游硬體造成的 CPU 浪費，後端實作了 **設備 scope 自適應排程器**：
* **心跳上報**：前端每 5 秒只替目前可見設備頁送出 `GET /api/heartbeat?scope=...`。切頁會立即取代上一頁 scope，分頁進背景也會主動釋放；若瀏覽器異常中斷，伺服器租約仍會自動到期。
* **頻率切換邏輯**：
  * UCG／NAS／WiiM／UPS／AdGuard／Linux 設備頁可見時，該頁所有前端資訊以 **3 秒** 間隔更新；trend／UCG／NAS／WiiM／Linux 對應歷史取樣也以 3 秒執行。
  * 離開設備頁後，前端立即停止上一頁輪詢；後端 scope 被撤銷或租約到期後恢復各設備原本的低頻間隔。總覽維持各項預設，避免同時高頻查詢全部設備。
* **數據持久化**：一般遙測先進入有上限的記憶體 queue，查詢會合併未落盤點；預設每 10 分鐘或達 1,000 筆／1 MiB 時以單一 transaction 批次寫入 SQLite。

### 2.3 威脅安全評分模型與自動隔離機制 (Security Model & Auto Defense)
* **資安評分公式**：安全評分起點為 100 分。系統掃描近 24 小時內的 IPS/IDS 威脅事件（`ips:alert`）：
  $$\text{扣分 Penalty} = \sum (\text{威脅嚴重性基礎分} \times \text{威脅類別加權倍率})$$
  * `HIGH` 等級事件基礎扣 4 分，`MEDIUM` 扣 2 分，`LOW` 扣 1 分。
  * 若威脅類別屬於高度危險的 `Malware` 或 `DoS` 攻擊，則乘以 `1.5` 倍的加權倍率。
  * 計算得出最終分數，最低為 0 分。威脅事件一旦在 24 小時後過期，扣分自動失效，評分緩慢回復至 100 分。
* **主動式自動隔離機制 (autoDefense Sweep)**：
  * 後端啟動一個背景監看任務（每 30 秒執行一次），自動過濾 `ips:alert` 日誌中的最新事件。
  * 當偵測到內網中某設備的 MAC 地址發出高危類別（如 `Malware`、`Trojan`、`Botnet` 或 `C2`）的連線警報時，若本地設定 `autoDefense` 啟用，後端會主動調用 UniFi 本地 API 將該 MAC 加入封鎖清單（實施 `block-sta` 物理級隔離）。
  * 系統會自動記錄至 `data/block-history.json` 中，並註記發起者為 `[auto]`。

### 2.4 定期報表與推播通知系統 (Reporting & Push Watcher)
* **通知監控 (`notificationWatcher`)**：以 20 秒為預設間隔背景掃描 IPS 威脅警報與 NAS 系統異常事件，排重後調用 `notify()` 發送即時推播。為防止伺服器重啟時重複推送歷史事件，首輪執行僅進行數據標記，不觸發實際推送。
* **報表排程器 (`scheduleServerJobs`)**：解析 `data/app-settings.json` 的報表設定，定時於每日/每週指定時間彙整 UniFi 流量、威脅趨勢與 WiiM 溫度表現，產生報表文字，並發送至指定的 Webhook 頻道。
* **Webhook 渠道**：支援 Discord 格式化 Rich Embedded 訊息、Telegram Bot API 原生發送，以及 Universal 通用 HTTP POST 格式。

### 2.5 WiiM 溫度監控快取與統計機制 (WiiM Telemetry & 2s Cache)
* **背景溫度遙測 (`pollWiimTemp`)**：每 10 秒（預設）自動調用 WiiM HTTP API 的 `getStatusEx`，讀取 `temperature_cpu` 與 `temperature_tmp102`。將包含時間戳的數據寫入內存佇列 `wiimHistory`（上限 5,000 筆）。
* **唯讀快取機制 (`wiimCache`)**：針對讀取型命令實作 2 秒臨時快取。2 秒內重複的狀態讀取請求直接從快取返回，保護 WiiM 的弱處理器不被重複的瀏覽器輪詢沖垮。
* **前端 4 卡片渲染**：前端對接後端並以折線圖呈現，提供「最低 / 平均 / 最高」值即時過濾、資料點切換開關、下載 CSV 與歷史清空等完整操作面板。

---

## 3. 完整 API 端點對照表 (Complete Endpoint Registry)

後端 Express 路由全量定義表如下，明列了各端點功能、參數、上游呼叫方式與安全降級方案：

| 請求方法與路徑 | 功能說明 | 請求參數/Body 格式 | 下游/上游通訊方式 | Fallback 備用回退機制 (無 Key/連線失敗時) |
| :--- | :--- | :--- | :--- | :--- |
| `GET /api/hardware` | 獲取 UCG-Ultra 實體硬件狀態 | 無 | SSH 連線執行 `ubnt-systool cputemp`、`free -m` 等共 9 條命令（含 1 秒 sleep 計算 delta） | 返回 500 錯誤（核心硬體必須連線） |
| `GET /api/clients` | 獲取活躍客戶端清單 | 無 | 本地控制器 API 呼叫 `GET /api/s/default/stat/sta` | 返回 500 錯誤 |
| `GET /api/wifi-networks` | 獲取 SSID 設定清單 | 無 | 本地控制器 API 呼叫 `GET /api/s/default/rest/wlanconf` | 返回 500 錯誤 |
| `PUT /api/wifi-networks/:id` | 修改 SSID 啟用/停用狀態 | `{"enabled": true/false}` | 本地控制器 API 呼叫 `PUT /api/s/default/rest/wlanconf/{id}` | 返回 500 錯誤 |
| `GET /api/threats` | 獲取近 24 小時 IPS/IDS 警報 | 無 | 本地控制器 API 呼叫 `GET /api/s/default/stat/alarm` | 返回 500 錯誤 |
| `PUT /api/device/restrict` | 封鎖或解封特定 MAC 設備 | `{"deviceId": "MAC", "blockState": true/false}` | 本地控制器 API 呼叫 `POST /api/s/default/cmd/stamgr` (`block-sta` / `unblock-sta`)，並寫入 `block-history.json` | 返回 500 錯誤 |
| `GET /api/block-history` | 讀取本地控制阻斷歷史紀錄 | 無 | 讀取本地 `data/block-history.json` 檔案 | 返回空陣列 `[]` |
| `POST /api/poe/power-cycle` | PoE 埠斷電重啟控制 | `{"switchMac": "MAC", "portIndex": 1}` | 本地控制器 API 呼叫 `POST /api/s/default/cmd/devmgr` (`power-cycle`) | 返回 500 錯誤 |
| `POST /api/speedtest` | 觸發控制器執行 WAN 速度測試 | 無 | 本地控制器 API 呼叫 `POST /api/s/default/cmd/devmgr` (`speedtest`) | 返回 500 錯誤 |
| `GET /api/speedtest/status` | 查詢測速進度與最新數據 | 無 | 本地控制器 API 呼叫 `GET /api/s/default/stat/health`，取 `www` 子系統數據 | 返回 500 錯誤 |
| `GET /api/cloud/sites` | 獲取雲端 Site Manager 站點 | 無 | 雲端 API 呼叫 `GET /v1/sites` | 返回內建台北總部模擬資料（`source: 'fallback'`） |
| `GET /api/cloud/devices` | 獲取雲端跨站點硬體設備清單 | 無 | 雲端 API 呼叫 `GET /v1/devices` | 返回內建 UCG-Ultra、USW-24-PoE 模擬設備清單 |
| `GET /api/cloud/hosts` | 獲取雲端註冊 Console 主機清單 | 無 | 雲端 API 呼叫 `GET /v1/hosts` | 返回模擬主機清單 |
| `GET /api/cloud/sdwan` | 獲取雲端 SD-WAN 組態列表 | 無 | 雲端 API 呼叫 `GET /v1/sd-wan-configs` | 返回模擬 VPN 連線清單 |
| `GET /api/cloud/isp-metrics` | 獲取近 24 小時 WAN 口指標 | 無 | 雲端 API 呼叫 `GET /v1/isp-metrics/5m?duration=24h` | 返回模擬中華電信測速與延遲指標 |
| `GET /api/security/settings` | 獲取自動防禦設定 | 無 | 讀取本地 `data/security-settings.json` | 返回預設啟用狀態 `{"autoDefense": false}` |
| `POST /api/security/settings` | 修改自動防禦聯動設定 | `{"autoDefense": true/false}` | 寫入本地 `data/security-settings.json` | 返回 500 錯誤 |
| `GET /api/notifications/settings` | 獲取通知頻道與設定（遮罩） | 無 | 讀取本地 `data/notification-settings.json`（對 API 金鑰欄位回傳布林狀態） | 返回預設通知設定檔 |
| `POST /api/notifications/settings` | 修改通知頻道（保留空值免覆寫）| 表單 JSON 格式 | 寫入本地 `data/notification-settings.json` | 返回 500 錯誤 |
| `POST /api/notifications/test` | 立即送出一則測試通知 | 無 | 調用 `notify()` 對已設定的 Webhook 頻道發送測試簡訊 | 返回 500 錯誤 |
| `GET /api/notifications/log` | 獲取通知歷史日誌 | 無 | 讀取內存 `notifLog` 陣列（上限 50 筆） | 返回空陣列 `[]` |
| `GET /api/history` | 讀取全局趨勢折線圖數據 | 無 | 讀取本地 `data/trend-history.json` | 返回預設空結構 |
| `GET /api/heartbeat` | 前端上報活躍心跳狀態 | 無 | 更新背景取樣器的活躍判斷時間戳記並返回當前狀態 | 返回當前排程活躍狀態 |
| `GET /api/nas/overview` | UGREEN NAS 硬體健康與遙測 | 無 | UGOS 原生 API 呼叫 `/sysinfo/machine/common` 與 `/taskmgr/stat/get_all` | 返回預設 mockNasOverview 模擬資料 |
| `GET /api/nas/disks` | UGREEN NAS 實體硬碟列表 | 無 | UGOS 原生 API 呼叫 `/storage/disk/list` | 返回 mockNasDisks 模擬資料 |
| `GET /api/nas/volumes` | UGREEN NAS 邏輯儲存空間列表 | 無 | UGOS 原生 API 呼叫 `/storage/volume/list` | 返回 mockNasVolumes 模擬資料 |
| `GET /api/nas/ups` | UGREEN NAS 連接 UPS 設定資訊 | 無 | UGOS 原生 API 呼叫 `/hardware/ups/config` | 返回 mockNasUps 模擬資料 |
| `GET /api/nas/ups-usb` | UGREEN NAS 連接 UPS 遙測詳情 | 無 | UGOS 原生 API 呼叫 `/hardware/ups/usb/info` | 返回 mockNasUps 模擬資料 |
| `GET /api/nas/docker` | 獲取 NAS Docker 容器清單 | 無 | NAS Monitor 擴充 API `GET /api/docker/containers` | 返回模擬 Docker 容器清單（4個範例） |
| `POST /api/nas/docker/:id/:action` | 控制特定 Docker 容器啟停 | `action`: `start/stop/restart` | NAS Monitor 擴充 API `POST /api/docker/containers/{id}/{action}` | 返回 500 錯誤 |
| `GET /api/nas/docker/:id/logs` | 獲取特定 Docker 容器最新日誌 | 無 | NAS Monitor 擴充 API `GET /api/docker/containers/{id}/logs` | 返回模擬容器運行日誌 |
| `GET /api/nas/traffic-summary` | 獲取今日/本週/本月網路流量 | 無 | NAS Monitor 擴充 API `GET /api/traffic/summary` | 返回模擬流量中繼包 |
| `GET /api/nas/traffic-history` | 獲取 NAS 歷史流量紀錄 | 無 | NAS Monitor 擴充 API `GET /api/traffic/history` | 返回模擬歷史流量對照組 |
| `GET /api/nas/system-history` | 獲取 NAS CPU/記憶體/溫度歷史 | 無 | NAS Monitor 擴充 API `GET /api/system/history` | 返回模擬負載歷史組 |
| `GET /api/nas/temperature-history` | 獲取 NAS 硬碟與風扇溫度歷史 | 無 | NAS Monitor 擴充 API `GET /api/temperature/history` | 返回模擬風扇歷史數據 |
| `GET /api/nas/storage-history` | 獲取 NAS 儲存容量歷史趨勢 | 無 | NAS Monitor 擴充 API `GET /api/storage/history` | 返回模擬硬碟容量歷史組 |
| `GET /api/nas/storage-forecast` | 獲取儲存滿載時間預估天數 | 無 | NAS Monitor 擴充 API `GET /api/storage/forecast` | 返回模擬滿載預估天數 |
| `GET /api/nas/downtime` | 獲取 NAS 系統運行穩定率 | 無 | NAS Monitor 擴充 API `GET /api/downtime` | 返回模擬正常時間與運行率 |
| `GET /api/nas/alerts` | 獲取 NAS 進階系統警報清單 | 無 | NAS Monitor 擴充 API `GET /api/alerts/events` | 返回模擬系統事件清單 |
| `POST /api/nas/alerts/:id/ack` | 確認並消除特定的系統警報 | 無 | NAS Monitor 擴充 API `POST /api/alerts/events/{id}/acknowledge` | 返回 500 錯誤 |
| `GET /api/settings` | 獲取伺服器排程取樣間隔設定 | 無 | 讀取本地 `data/app-settings.json` | 返回當前 appSettings |
| `POST /api/settings` | 修改伺服器排程取樣間隔 | 表單 JSON 格式 | 寫入本地 `data/app-settings.json`，並即時重整排程排程器 | 返回 500 錯誤 |
| `POST /api/reports/run` | 手動即時彙整生成戰情室報表 | 無 | 觸發 `buildReport()` 並回傳生成的報表文字 (若啟用則推送至 Webhook) | 返回 500 錯誤 |
| `GET /manifest.webmanifest` | 提供 PWA 網頁清單描述檔 | 無 | 後端 Express 動態返回 JSON 檔案 | 無 |
| `GET /sw.js` | 提供 PWA Service Worker 腳本 | 無 | 後端 Express 動態返回離線快取控制腳本 | 無 |
| `GET /api/wiim/history` | 獲取內存中的 WiiM 歷史溫度 | 無 | 讀取後端內存 `wiimHistory` 佇列 | 返回包含 interval 等屬性的空資料集 |
| `GET /api/wiim/status` | 獲取 WiiM 狀態與遙測詳情 | `type`: `play/status/all` | WiiM HTTP API 呼叫 `getPlayerStatus`、`getMetaInfo` 或 `getStatusEx` | 返回 fallback 模擬資料（`WiiM Amp Testbed`） |
| `GET /api/wiim/cmd` | 發送播放與系統控制指令至 WiiM | `command`: 具體指令字串 | WiiM HTTP API 呼叫 `httpapi.asp?command={command}` | 返回 500 錯誤 |
| `GET /api/wiim/clear` | 清空記憶體中的 WiiM 歷史溫度 | 無 | 重設後端內存 `wiimHistory = []` | 返回成功 JSON `{ok: true}` |
| `GET /api/wiim/csv` | 匯出 WiiM 溫度歷史日誌為 CSV | 無 | 將內存中的 `wiimHistory` 即時轉化為 CSV 字串輸出並提供下載 | 返回僅包含標題列的空 CSV 檔案 |

---

## 4. 關鍵設計規範與程式碼約定 (Conventions)

為防止後續開發的 AI 助手亂寫程式碼，本專案必須嚴格遵守以下代碼規範：

### 4.1 後端 Express 開發規範
1. **無狀態設計 (Stateless Endpoints)**：除了內存中的暫時快取與取樣歷史（如 `wiimHistory`、`notifLog`），所有業務端點均應為無狀態。資料必須持久化於 `data/` 中的 JSON 檔案，以方便容器重啟或遷移。
2. **錯誤防禦性處理 (Fallback Principle)**：外部調用失敗時，禁止在 API 端點直接拋出 500 錯誤，特別是雲端 Site Manager 與 NAS 遙測。必須捕獲錯誤，回傳 `fallback` 展示數據，並回傳 HTTP 200，在 response JSON 中標記 `source: 'fallback_on_error'` 與 `error: err.message`。
3. **金鑰覆寫安全規範**：在處理敏感設定變更的 POST/PUT 請求（如通知 Webhook URL、密碼、Token）時，如果前端發送的欄位為空，後端**絕對不能**以空值覆蓋，必須保留原有檔案中已儲存的金鑰。
4. **統一結構化偵錯日誌 (Structured Debug Logging)**：後端所有關鍵功能均使用統一的 `sysLog(module, message, isError)` 進行輸出，日誌自帶格式化本地時間（zh-TW）與徽標。嚴禁在路由中直接呼叫無上下文標籤的 `console.log/error`，以保證 Docker 容器日誌的可讀性。

### 4.2 前端 SPA 開發規範
1. **禁止使用第三方編譯工具**：`public/index.html` 必須是純 Vanilla JS 與 HTML。不使用 Webpack、Vite 或 React，只引用 CDN 提供的 TailwindCSS、Chart.js 與 D3.js。
2. **Tab 切換架構**：所有的導航切換統一由 `switchTab(tabId)` 控制。每個分頁必須是一個帶有 `tab-content` 類別的 `<section>`，且切換時透過新增/移除 `.hidden` 類別來顯示，以防銷毀 Chart.js 畫布。
3. **彈窗 DOM 擺放規範**：所有模態彈窗（Modal，例如客戶端詳情、Docker 日誌等）必須擺放在 `<body>` 的最頂層直屬子元素，嚴禁將其放置在任何具有 `backdrop-blur` (毛玻璃) 濾鏡的容器祖先內，以防 CSS 渲染引擎的 `position: fixed` 定位跑位。

---

## 5. AI 開發與修改指引 (AI Developer Playbooks)

未來的 AI 工具如果要修改此專案，請按照以下經典場景的標準工作流操作：

### 場景 A：新增一個後端 API 與前端卡片
1. **在 [server.js](file:///Users/steven/Desktop/unifi/unifi-smarthub/server.js) 新增路由**：
   * 在 API 路由宣告區域（約第 1320 行起）插入新的端點，包含必要的 Error Catch 與 Mock 降級機制。
2. **同步至 [server-mock.js](file:///Users/steven/Desktop/unifi/unifi-smarthub/server-mock.js)**：
   * 實作完全相同的路徑與請求參數，返回結構對齊的靜態 Mock 物件。
3. **在 [public/index.html](file:///Users/steven/Desktop/unifi/unifi-smarthub/public/index.html) 新增卡片**：
   * 尋找目標分頁的 HTML 結構，插入對應的 Tailwind 樣式網格卡片。
4. **編寫前端拉取與渲染邏輯**：
   * 在前端 JavaScript 區塊編寫 `fetchMyNewAPI()`，取得數據後使用 `document.getElementById('...').textContent` 或 class 切換渲染至 DOM。

### 場景 B：新增一個可供使用者配置的定時輪詢任務 (POLL_JOBS)
1. **在前端宣告**：
   * 搜尋 `const POLL_JOBS = {`（約在設定頁前端邏輯附近），插入新的輪詢屬性：
     ```javascript
     myCustomJob: { 
         fn: () => fetchMyCustomData(), 
         def: 15, 
         label: '抓取自訂資料', 
         desc: '每隔設定秒數向後端抓取...的數據' 
     }
     ```
   * 系統會自動為其生成「設定頁中的滑桿/輸入框」，並將間隔秒數持久化到前端瀏覽器的 `localStorage.pollConfig` 中，無須再手動編寫定時器。

### 場景 C：在側邊欄新增一個全新的獨立分頁頁籤
1. **加入側邊欄按鈕**：
   * 尋找側邊欄導航選單 `<aside>` 標籤中的清單項，複製現有連結並新增：
     ```html
     <a href="#" onclick="switchTab('my-new-page')" data-tab="my-new-page" class="sidebar-btn ...">
         <span>💡 新功能分頁</span>
     </a>
     ```
2. **建立分頁容器**：
   * 在 `<main>` 標籤中建立對應的 section 區塊：
     ```html
     <section id="tab-my-new-page" class="tab-content hidden space-y-6">
         <!-- 卡片與主要內容 -->
     </section>
     ```
3. **連結初始化邏輯**：
   * 在 `switchTab(tabId)` 被觸發的 callback 區塊中判斷 `if (tabId === 'my-new-page') { fetchMyNewPageData(); }`，確保切換至該分頁時才發送 API 請求。
