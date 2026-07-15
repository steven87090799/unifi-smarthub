# SmartHub 專案技術規格書與 AI 導引指南 (spec.md)

本文件保留高密度架構背景與歷史 API 參考，但不是 live route registry。正式契約以 `SERVER-MAP.md`、`FRONTEND-MAP.md`、共用 policy/route modules、production/mock contract tests 與實際 source 為準；部署以 `README.md` 與 `PRODUCTION-RELEASE-CHECKLIST.md` 為準。新增或修改 endpoint 時不可只更新本文件而略過 production/mock tests。

---

## 1. 核心專案結構 (Core Directory Map)

以下列出 `unifi-smarthub` 的核心模組與職責；完整檔案清單以 `rg --files` 為準：

```text
unifi-smarthub/
├── .dockerignore                 # 排除不需打包進 Docker 映像檔的檔案與資料夾 (如 node_modules、data 磁碟區)
├── config/.env                   # 部署實例唯一設定 authority；機密不進 Git，Compose 一律用 --env-file config/.env
├── .env.example                  # 環境變數範本檔，明列 UniFi、UGREEN 及 WiiM 所需變數與連接 IP 預設值
├── .gitignore                    # Git 忽略設定，強制排除 node_modules、secret env 與 runtime data
├── AGENTS.md / CLAUDE.md          # 精簡 AI 工作入口與讀檔路由
├── Dockerfile                    # node:20-alpine、非 root、tini；Docker readiness healthcheck 使用 /health/ready
├── README.md                     # 使用者導向的專案介紹、部署步驟、Docker Compose 安裝與故障排除指引
├── cyberpower-ups-api.md         # CyberPower UPS 狀態監控與 IOKit 診斷協定參考文件
├── docker-compose.yml            # 主服務 + opt-in NAS Monitor profile、專用 config bind、具名 data volume 與 resource/security limits
├── package-lock.json             # 鎖定 npm 依賴套件之確切版本與二進位雜湊值
├── package.json                  # 定義專案中繼資料、啟動腳本與生產依賴 (express, axios, ssh2, dotenv, cors)
├── server.js                     # [核心後端] 正式 Express 組裝入口、設備 clients、背景工作與 lifecycle
├── server/                       # 共用 middleware/policy/routes/jobs/services/integrations，可由 production 與 mock 共用
├── observability/                # structured logger、issue/task tracker、system monitor 與 health routes
├── server-mock.js                # [模擬後端] 開發與預覽專案專用的無依賴模擬伺服器，模擬真實 API 回應
├── ugreen-nas-api.md             # UGREEN UGOS Pro NAS 原生 API 的逆向工程與欄位解析參考手冊
├── unifi-network-api.md          # UniFi Network Controller (Legacy) 與 Site Manager API 規格文件
├── wiim-amp-api.md               # WiiM Amp HTTP API 與系統協定高密度參考規格
├── wiim_spec.md                  # 本專案整合 WiiM APIs 頻率、端點 payload 與欄位定義的專屬規格書
├── data/                         # runtime volume；SQLite + 少量 JSON 設定，repository 不追蹤
│   ├── smarthub.db               # WAL SQLite：歷史、事件、reports、policies、claims、subscriptions 與 audit
│   ├── security-settings.json    # 自動防禦等應用設定
│   ├── notification-settings.json# 通知通道與 trigger 設定
│   └── app-settings.json         # 取樣、retention 與 report schedule 設定
└── public/                       # SPA shell、獨立 feature JS、deterministic CSS 與靜態資產
    ├── index.html
    ├── js/web-push.js
    └── assets/tailwind.css
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
* **心跳上報**：前端每 5 秒只替目前可見頁面送出 `GET /api/heartbeat?scope=...`。切頁會立即取代上一頁 scope，分頁進背景也會主動釋放；若瀏覽器異常中斷，伺服器租約仍會自動到期。
* **頻率切換邏輯**：
  * 總覽或 UCG／NAS／WiiM／UPS／AdGuard／Linux 設備頁可見時，該頁所有前端資訊以 **3 秒** 間隔更新；總覽會同時啟用 trend／UCG／NAS／WiiM scope，後端對應歷史取樣也以 3 秒執行。
  * 離開總覽或設備頁後，前端立即停止上一頁輪詢；後端 scope 被撤銷或租約到期後恢復各設備原本的低頻間隔。
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
  * 系統會以 `db.js` 寫入 SQLite block history，並註記自動隔離來源。

### 2.4 定期報表與推播通知系統 (Reporting & Push Watcher)
* **通知監控 (`notificationWatcher`)**：以 20 秒為預設間隔背景掃描 IPS 威脅警報與 NAS 系統異常事件，排重後調用 `notify()` 發送即時推播。為防止伺服器重啟時重複推送歷史事件，首輪執行僅進行數據標記，不觸發實際推送。
* **報表排程器 (`ReportRunner`)**：解析 `data/app-settings.json` 的報表設定，以 deterministic schedule key 和 SQLite owner-fenced claim/retry/recovery 執行，避免 restart 或 concurrent trigger 靜默重複；partial delivery 是 terminal 且可觀察。
* **Webhook 渠道**：支援 Discord 格式化 Rich Embedded 訊息、Telegram Bot API 原生發送，以及 Universal 通用 HTTP POST 格式。

### 2.5 WiiM 溫度監控快取與統計機制 (WiiM Telemetry & 2s Cache)
* **背景溫度遙測 (`pollWiimTemp`)**：依 activity scope 自適應調用 WiiM HTTP API 的 `getStatusEx`，讀取 `temperature_cpu` 與 `temperature_tmp102`，並透過有上限的 history queue 批次寫入 SQLite。
* **唯讀快取機制 (`wiimCache`)**：針對讀取型命令實作 2 秒臨時快取。2 秒內重複的狀態讀取請求直接從快取返回，保護 WiiM 的弱處理器不被重複的瀏覽器輪詢沖垮。
* **前端 4 卡片渲染**：前端對接後端並以折線圖呈現，提供「最低 / 平均 / 最高」值即時過濾、資料點切換開關、下載 CSV 與歷史清空等完整操作面板。

---

## 3. 歷史 API 端點參考（非完整 registry）

下表只保留早期主要 endpoint 的背景，不涵蓋目前所有 security、backup、Web Push、AdGuard policy、threat block、health 或 mock routes，也不代表當前 auth/status/schema contract。新增或驗證 route 時，先查 `SERVER-MAP.md`，再以 `rg`、route policy module 與 `test/write-route-contract.test.js` 等 contract tests 確認 live behavior。

| 請求方法與路徑 | 功能說明 | 請求參數/Body 格式 | 下游/上游通訊方式 | Fallback 備用回退機制 (無 Key/連線失敗時) |
| :--- | :--- | :--- | :--- | :--- |
| `GET /api/hardware` | 獲取 UCG-Ultra 實體硬件狀態 | 無 | SSH 連線執行 `ubnt-systool cputemp`、`free -m` 等共 9 條命令（含 1 秒 sleep 計算 delta） | 返回 500 錯誤（核心硬體必須連線） |
| `GET /api/clients` | 獲取活躍客戶端清單 | 無 | 本地控制器 API 呼叫 `GET /api/s/default/stat/sta` | 返回 500 錯誤 |
| `GET /api/wifi-networks` | 獲取 SSID 設定清單 | 無 | 本地控制器 API 呼叫 `GET /api/s/default/rest/wlanconf` | 返回 500 錯誤 |
| `PUT /api/wifi-networks/:id` | 修改 SSID 啟用/停用狀態 | `{"enabled": true/false}` | 本地控制器 API 呼叫 `PUT /api/s/default/rest/wlanconf/{id}` | 返回 500 錯誤 |
| `GET /api/threats` | 獲取近 24 小時 IPS/IDS 警報 | 無 | 本地控制器 API 呼叫 `GET /api/s/default/stat/alarm` | 返回 500 錯誤 |
| `PUT /api/device/restrict` | 封鎖或解封特定 MAC 設備 | `{"deviceId": "MAC", "blockState": true/false}` | 本地 controller mutation + SQLite block history | upstream failure 有明確 error contract |
| `GET /api/block-history` | 讀取本地控制阻斷歷史紀錄 | 無 | SQLite bounded history | 返回 `{"history":[]}` |
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
| `GET /api/history` | 讀取全局趨勢折線圖數據 | bounded query | SQLite history + 尚未 flush 的 bounded queue | 返回預設空結構 |
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
| `GET /api/wiim/history` | 獲取 WiiM 歷史溫度 | 無 | 讀取 SQLite `wiim` series | 返回包含 interval 等屬性的空資料集 |
| `GET /api/wiim/status` | 獲取 WiiM 狀態與遙測詳情 | `type`: `play/status/all` | WiiM HTTP API 呼叫 `getPlayerStatus`、`getMetaInfo` 或 `getStatusEx` | 無回應時回 `source: unreachable`，不偽造 production telemetry |
| `GET /api/wiim/cmd` | typed readonly WiiM commands | `command`: server allowlist 中的唯讀指令 | bounded WiiM transport + 2 秒 read cache | 未知或 mutation command 拒絕 |
| `POST /api/wiim/cmd` | typed WiiM mutation | exact JSON policy | admin + Origin/CSRF + explicit command/parameter validation | readonly/unknown/high-risk command 拒絕 |
| `DELETE /api/wiim/history` | 清空 WiiM 歷史溫度 | empty body | 刪除 SQLite `wiim` series | 返回成功 JSON `{ok: true}` |
| `GET /api/wiim/csv` | 匯出 WiiM 溫度歷史日誌為 CSV | 無 | 將 SQLite `wiim` series 轉為 CSV 並下載 | 返回僅包含標題列的空 CSV 檔案 |

---

## 4. 關鍵設計規範與程式碼約定 (Conventions)

為防止後續開發的 AI 助手亂寫程式碼，本專案必須嚴格遵守以下代碼規範：

### 4.1 後端 Express 開發規範
1. **權威 persistence**：歷史、事件、claims、policies、subscriptions 與 audit 使用 `db.js` 的 SQLite 介面；JSON 只保留少量人類可讀設定。in-memory queue/cache 必須有容量、lifetime、cleanup owner 與 shutdown behavior。
2. **錯誤語意**：只有產品明確定義的 optional/demo fallback 才能回 fallback。認證、transport、write、partial delivery 或 authoritative data failure 不可用 HTTP 200 偽裝成功，也不可把 raw upstream `error.message` 或 secret 回傳前端。
3. **金鑰覆寫安全規範**：在處理敏感設定變更的 POST/PUT 請求（如通知 Webhook URL、密碼、Token）時，如果前端發送的欄位為空，後端**絕對不能**以空值覆蓋，必須保留原有檔案中已儲存的金鑰。
4. **統一結構化日誌**：新模組使用 `observability/logger.js` 的 level、request/task context、status code 與 secret masking；legacy `sysLog()` 是 adapter，不是新 API。不得記錄 Authorization、cookie、password、token、API key、CSRF token、webhook 或高頻未去重錯誤。

### 4.2 前端 SPA 開發規範
1. **同源 deterministic runtime**：維持 Vanilla JS/HTML，不需要 Webpack/Vite/React runtime；Tailwind 由 `npm run build:css` 產生，Chart.js/D3/TopoJSON/world-atlas 只從帶確切版本的同源 `/vendor/` route 提供，禁止 CDN runtime dependency。
2. **Page 切換架構**：側邊欄 button 使用 `data-page` + `navigate(page)`；每個分頁對應 `id="page-<name>"` 的 `<section>`，切換以 `.hidden` 控制並由 `navigate()` 擁有 activity scope、polling 與 feature initialization。
3. **彈窗 DOM 擺放規範**：所有模態彈窗（Modal，例如客戶端詳情、Docker 日誌等）必須擺放在 `<body>` 的最頂層直屬子元素，嚴禁將其放置在任何具有 `backdrop-blur` (毛玻璃) 濾鏡的容器祖先內，以防 CSS 渲染引擎的 `position: fixed` 定位跑位。

---

## 5. AI 開發與修改指引 (AI Developer Playbooks)

未來的 AI 工具如果要修改此專案，請按照以下經典場景的標準工作流操作：

### 場景 A：新增一個後端 API 與前端卡片
1. **在 `server.js` 新增路由**：
   * 先用 `SERVER-MAP.md` 與 `rg` 找到相近 route owner；優先在可共用的 `server/routes/` + policy module 實作，套用現有 auth/role/Origin/CSRF/input/error contract。
2. **同步至 `server-mock.js`**：
   * 實作完全相同的路徑與請求參數，返回結構對齊的靜態 Mock 物件。
3. **在 `public/index.html` 新增卡片**：
   * 尋找目標分頁的 HTML 結構，插入對應的 Tailwind 樣式網格卡片。
4. **編寫前端拉取與渲染邏輯**：
   * 在前端 JavaScript 區塊編寫 `fetchMyNewAPI()`，取得數據後使用 `document.getElementById('...').textContent` 或 class 切換渲染至 DOM。

### 場景 B：新增一個可供使用者配置的定時輪詢任務 (POLL_JOBS)
1. **在前端宣告**：
   * 搜尋 `const POLL_JOBS = {`，插入新的輪詢屬性：
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
   * 尋找側邊欄導航選單 `<aside>` 的 `.nav-btn`，加入：
     ```html
     <button data-page="my-new-page" onclick="navigate('my-new-page')" class="nav-btn nav-idle ...">
         <span>💡 新功能分頁</span>
     </button>
     ```
2. **建立分頁容器**：
   * 在 `<main>` 標籤中建立對應的 section 區塊：
     ```html
     <section id="page-my-new-page" class="hidden space-y-6">
         <!-- 卡片與主要內容 -->
     </section>
     ```
3. **連結初始化邏輯**：
   * 在 `navigate(page)` 的 page-specific initialization 加入 `my-new-page`，並在 `POLL_JOBS`/activity scope 中明確定義 visibility、重入與離頁 cleanup；不得另建無 owner 的 interval。
