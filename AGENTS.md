# SmartHub — 架構文件 (AGENTS.md)

## ⚡ 快速摘要（先讀這裡，再決定是否需要讀其他檔案）

這是一個 **Node.js + Express 後端 + 單頁前端** 的家用網路管理面板。

| 角色 | 檔案 | 大小 |
|---|---|---|
| **正式後端** | `server.js` | ~162 KB |
| **模擬後端** | `server-mock.js` | ~37 KB |
| **前端 SPA** | `public/index.html` | **533 KB（極大）** |
| **架構文件** | 本檔 `AGENTS.md` | ~24 KB |
| **低 Token 入口** | `CONTEXT.md` | 先讀這個決定後續讀檔 |
| **後端索引** | `SERVER-MAP.md` | 後端任務先讀 |
| **前端索引** | `FRONTEND-MAP.md` | 前端任務先讀 |

## 📋 檔案閱讀指引（節省 Token 原則）

> **請依任務性質決定是否讀取各檔案，不要預設一次讀全部。**

低成本讀檔順序：先讀 `CONTEXT.md` → 後端讀 `SERVER-MAP.md`、前端讀 `FRONTEND-MAP.md` → 再用 `rg`/`sed` 精準讀 `server.js` 或 `public/index.html` 片段。

### ✅ 預設不需要讀的檔案
- `public/index.html` — 533 KB 的巨型 SPA，**除非任務明確涉及前端 UI/JS/CSS 修改，否則不要讀取**
- `data/*.json` — 純歷史資料，幾乎不需要 AI 閱讀
- `package-lock.json` — npm lockfile，不需閱讀
- `.env` / `.env.*` — 含機密；debug 時先讀 `.env.example`，必要時只精準檢查特定欄位

### 📖 何時才需要讀 `public/index.html`
只有在以下情況才讀取：
- 修改前端 UI 佈局、樣式、動畫
- 新增或修改前端 JavaScript 功能（API 呼叫、圖表、互動）
- 調整 HTML 結構、新增頁面分頁
- 修復前端特定的 bug

**純後端任務**（修改 API 端點、修 server.js 邏輯、調整排程、除錯後端錯誤）→ **不需讀取 index.html**，僅讀 `server.js` 即可。

### 📖 其他檔案參考指引
- 需要了解 UniFi API 規格 → 讀 `unifi-network-api.md`
- 需要了解 NAS API 規格 → 讀 `ugreen-nas-api.md`
- 需要了解 WiiM 規格 → 讀 `wiim_spec.md` 或 `wiim-amp-api.md`
- 需要了解 UPS → 讀 `cyberpower-ups-api.md`
- 完整技術規格 → 讀 `spec.md`

---



客製化 UniFi × UGREEN NAS 雙系統管理面板。採「前後端分離」架構:前端 (public/index.html) 只呼叫本專案後端,`X-API-Key`、控制器帳密與 NAS 帳密僅存於後端,符合 `../unifi-network-api.md` §4.1 的安全要求。

## 專案結構

| 檔案 | 說明 |
| :--- | :--- |
| `server.js` | 正式後端 (Express, port 3000)。四種資料來源:SSH、控制器 Legacy API、雲端 Site Manager API、UGREEN UGOS Pro API |
| `server-mock.js` | 純模擬資料的開發用後端 (port 3005),無外部連線 |
| `public/index.html` | SPA 前端:側邊欄導航 + 7 個分頁(總覽/客戶端/資安/WiFi/雲端站點/NAS/工具) |
| `../unifi-network-api.md` | UniFi API 規格參考文件 (v10.3.58 / Site Manager v1.0.0) |
| `../ugreen-nas-api.md` | UGREEN UGOS Pro NAS API 規格參考文件(逆向工程) |
| `README.md` | 使用者導向的部署文件(所需資料、Docker 步驟、記憶體、歷史資料持久化、疑難排解) |
| `spec.md` | AI/開發者導向的高密度技術規格(完整目錄樹、模組邊界、資料流、全量 API 端點) |
| `wiim_spec.md` | WiiM Amp 整合專用規格(User-Agent 繞過、指令映射、欄位定義) |
| `Dockerfile` / `docker-compose.yml` | 容器部署:node:20-alpine + tini + 非 root + healthcheck;compose 含具名 volume、mem_limit 256m |

啟動:`npm start`(需 `.env`)或 `node server-mock.js`(免環境設定)或 `docker compose up -d --build`。

## 資料持久化

統計/歷史資料以 SQLite `smarthub.db` 存於 `DATA_DIR`(預設 `<專案>/data`,Docker 為 `/app/data` 並掛具名 volume `smarthub-data`)，設定類資料仍為 JSON。一般遙測先放記憶體 queue，預設每 10 分鐘或達 1,000 筆 / 1 MiB 時以單一 transaction 批次寫入；查詢會合併未落盤資料。UPS 事件、封鎖、報表與 NAS 日誌手機推播仍立即處理。首次啟動會將舊 history/event JSON 匯入並改名為 `.migrated.bak` 保留。`GET /health` 為 Docker liveness、`GET /health/ready` 檢查 SQLite/worker、`GET /api/system/status` 提供完整診斷。

**取樣為裝置感知的自適應頻率**:前端每 5 秒以 `GET /api/heartbeat?scope=...` 為目前可見頁面的 trend／NAS／WiiM／Linux 續約；後端以自身時間計算、每個 scope 最多只活躍 3 分鐘，沒有新心跳、切頁或分頁隱藏就自動回到低頻，避免錯誤判斷後持續高頻。總覽會替其顯示的 trend、NAS、WiiM 同時續約；`GET /api/history` 只加快 trend。UPS 取樣獨立，不受瀏覽狀態影響。

## 前端版面 (public/index.html)

- **側邊欄 + 分頁**(分群導航):總覽 →「網路監控」客戶端/資安/WiFi/雲端 →「設備」NAS/WiiM/UPS →「系統」工具/通知推播/設定;行動版為漢堡選單。左下角三行設備狀態(UCG/NAS/WiiM)。
- **液態玻璃 UI**:`body::before/::after` 兩顆極光光暈緩慢漂移;`main .rounded-2xl` 統一升級玻璃材質(漸層半透明+blur(20px) saturate+上緣高光+雙陰影),內層 `.rounded-xl` 薄玻璃;aside/header 玻璃化;深淺主題皆有對應覆寫。**新卡片只要用 rounded-2xl/rounded-xl 即自動獲得玻璃效果**。
- **Debug / Observability**:`observability/` 提供五級 structured logger、console/JSON、secret masking、request/task trace、SQLite latency、resource monitor、issue cooldown 與 60 筆 ring buffer；正常 API/job lifecycle 在 DEBUG，錯誤依 WARNING/ERROR/CRITICAL。前端 `dbg(module,...)` 可用 `localStorage.debug='0'` 關閉。
- **版面編輯(巢狀拖曳)**:右上 🧩 進入編輯。可排序容器 = `main > section` 頂層(藍虛線+⠿標籤)+ 任何標記 **`data-drag`** 的內部容器(綠虛線;全站 21 處:資安/NAS/雲端大卡內容、各雙欄 grid、KPI 迷你卡列、WiiM 左右欄、總覽體檢列等)。排序存 localStorage `layoutOrder.v1`(容器 key = section id 或 `data-drag-key`),集合不符自動忽略。拖曳 handler 有 `stopPropagation` 防巢狀連動;grid 內橫向卡片以 X 軸判斷插入點。**新增區塊時**:放進 data-drag 容器即自動可拖;新容器加 `data-drag` 屬性即可。跨容器移動不支援(避免破壞欄位佈局)。
- **總覽**:4 張 KPI 卡(WAN、線上設備、24H 威脅、雙設備溫度 UCG/NAS)+ **雙設備即時體檢面板**(UCG 與 NAS 並排,各顯示 CPU 溫度大字 + CPU/記憶體條 + 關鍵指標與連線徽章,點擊可下鑽)+ 資安戰情速覽 + 歷史趨勢圖 + UCG 硬體詳情。體檢面板的 UCG 欄由 `fetchHardware`/`fetchClients` 填(`ov-ucg-*`),NAS 欄由 `fetchNas` 填(`ov-nas-*`);溫度配色用 `tempColor()`/`tempLabel()`(涼爽<55/正常<65/偏高<75/過熱≥75)。目的:兩台設備重點不用切頁即可一次看清。
- **客戶端**:管理表格 + Top 5 流量排行榜 + 封鎖歷史時間軸。
- **總覽 → 資安戰情速覽**:安全評分環(0-100 + 等級)、24H 每小時威脅柱狀圖、最新攔截事件流,點「進入完整戰情室」跳資安頁。
- **資安**(完整):6 格 KPI 列、**可展開的「評分計算方式」說明卡**(公式、嚴重度基礎分 HIGH−4/MED−2/LOW−1、類別倍率 Malware/DoS×1.5、A–F 等級對照、當前扣分明細)、自動防禦聯動開關、每小時堆疊柱狀圖、威脅世界地圖、戰情室、Top 三欄分析、事件表(四重篩選 + CSV 匯出 + 來源 IP 複製)。
- **安全評分**:`securityScoreDetail(threats)` 回傳 `{score,count,high,medium,low,boosted,penalty}`;`updateSecurityAnalytics` 同時把扣分明細寫進總覽評分環下方(`ov-score-explain`)與資安頁說明卡(`sec-score-explain`),讓 0–100 分數有可解釋依據。分數只看近 24 小時,威脅停止後自動回升。
- **NAS**:CPU/RAM/網路/UPS 四卡 + 硬碟健康 + 儲存區容量條 + Raw JSON 除錯區。
- **工具**:測速(待機→轉圈動畫→結果儀表盤)+ PoE 斷電重啟。
- **通知推播**:推播設定(啟用開關、管道 Discord/Telegram/通用 Webhook、觸發條件、測試按鈕)+ 近期推播紀錄。後端 `notificationWatcher`(間隔可調)偵測新 `ips:alert`、NAS 嚴重警報(NAS Monitor)、**NAS 系統日誌全量推播**(UGOS 日誌中心所有事件,僅排除本站登入;`triggerNasLog` 預設開啟)等,去重後透過 `notify()` 推播;首輪僅記錄既有事件避免啟動時洗版。機密欄位在 GET 遮罩、POST 留空不覆寫。
- **設定**:外觀主題(深/淺,存 localStorage,右上角快速切換)、定期報表(每日/每週 + 時間 + 立即預覽)、前端輪詢間隔(12 項,存 localStorage,`POLL_JOBS` + `applyPolling()`)、伺服器端取樣間隔(存 `app-settings.json`)。
- **前端輪詢**:全部經 `POLL_JOBS` 表 + `applyPolling()` 統一管理(取代原本寫死的 setInterval);間隔存 localStorage `pollConfig`,可於設定頁即時調整。
- **主題**:`html.light` class + `<style>` 內的淺色覆寫規則(針對常用 slate 類別 `!important` 覆寫)。強調色(藍/紅/綠)保留。
- **PWA**:`<link rel=manifest>` + `apple-mobile-web-app-*` metas + `theme-color`;head 內聯 script 儘早套用主題並註冊 SW。
- **客戶端詳情 / Docker 日誌彈窗**:top-level modal(置於 `<body>` 直屬,避開 `backdrop-blur` 對 `position:fixed` 的影響)。
- **手機版**:側邊欄漢堡選單(`toggleSidebar`),KPI/圖表 grid 響應式堆疊,寬表格外層 `overflow-x-auto`;已驗證 375px 無水平溢位。
- CDN 依賴:tailwind、chart.js、d3@7、topojson-client@3、world-atlas JSON、qrserver(QR 圖)。

## 環境變數 (.env)

**UniFi**:`UNIFI_CONTROLLER_URL`, `UNIFI_USERNAME`, `UNIFI_PASSWORD`(本地控制器)、`UNIFI_API_KEY`(Site Manager)、`UCG_IP`, `SSH_USER`, `SSH_PASSWORD`, `SSH_PORT`, `WAN_IFACE`(預設 eth4,硬體頁 WAN 標籤)、`PORT`。
**UGREEN NAS**:`NAS_HOST`, `NAS_PORT`(預設 9443)、`NAS_SCHEME`(預設 https)、`NAS_USER`, `NAS_PASSWORD`。
未設定對應變數(或 `UNIFI_API_KEY` 含 `your_unifi` 佔位字串)時,雲端與 NAS 端點自動回退至內建 mock 資料 (`source: 'fallback'`)。

## 後端 API 與上游對應

### A. SSH 直連 (UCG-Ultra)
| 本專案端點 | 上游 | 備註 |
| :--- | :--- | :--- |
| `GET /api/hardware` | `ssh2` 執行 `ubnt-systool cputemp`、`free -m`、`df -m /`、`/proc/uptime`、`/proc/stat` ×2、`ip -s link` ×2、`/sys/class/net/*/speed` | **全部真實數據**:核心使用率來自 /proc/stat 兩次取樣差值、網卡速率來自 ip -s link 位元組差值(間隔 1 秒),已無任何模擬值 |

### B. 控制器本地 Legacy API(Cookie session 認證)
登入:`POST /api/auth/login`(UniFi OS),Cookie 快取 15 分鐘。

| 本專案端點 | 上游 Legacy 端點 |
| :--- | :--- |
| `GET /api/clients` | `GET /api/s/default/stat/sta` |
| `GET /api/wifi-networks` | `GET /api/s/default/rest/wlanconf` |
| `PUT /api/wifi-networks/:id` | `PUT /api/s/default/rest/wlanconf/{id}` |
| `GET /api/threats` | `GET /api/s/default/stat/alarm`(過濾 `key === 'ips:alert'`) |
| `PUT /api/device/restrict` | `POST /api/s/default/cmd/stamgr` (`cmd: block-sta` / `unblock-sta`),成功後寫入封鎖歷史 |
| `GET /api/block-history` | 無上游 — 讀取 SQLite `block_history`(僅記錄本面板下達的封鎖/解封,上限 200 筆) |
| `POST /api/poe/power-cycle` | `POST /api/s/default/cmd/devmgr` (`cmd: power-cycle`) |
| `POST /api/speedtest` | `POST /api/s/default/cmd/devmgr` (`cmd: speedtest`) |
| `GET /api/speedtest/status` | `GET /api/s/default/stat/health`(取 `www` 子系統的 `speedtest_status`/`xput_down`/`xput_up`/`speedtest_ping`) |
| `GET /api/history` | 無上游 — 讀取 SQLite `history` 的 `trend` series；內建自適應取樣器記錄客戶端數/24h 威脅數/ISP 延遲 |
| `GET/POST /api/security/settings` | 無上游 — 讀寫本地 `security-settings.json`(目前僅 `autoDefense` 布林) |
| `GET/POST /api/notifications/settings` | 無上游 — 讀寫本地 `notification-settings.json`。GET 遮罩機密(回 `webhookUrlSet`/`botTokenSet` 布林);POST 機密欄位留空=保留原值 |
| `POST /api/notifications/test` | 立即送一則測試推播 |
| `GET /api/notifications/log` | 近期推播紀錄(記憶體,50 筆) |
| `GET/POST /api/settings` | 讀寫 `app-settings.json`(伺服器端間隔:趨勢取樣/活躍視窗/監看器/自動防禦、報表設定)。POST 後即時 `scheduleServerJobs()` 重排 |
| `POST /api/reports/run` | 立即彙整並(若啟用)推播報表,回傳報表文字 |
| `GET/POST /api/connections` | **連線設定網頁化**:讀寫 `.env` 中 `CONN_FIELDS` 白名單欄位(SSH/UniFi/NAS/NAS Monitor/WiiM/UPS)。GET 機密只回 `secretsSet` 布林;POST 留空=不變更,寫入 `.env`(`persistEnvVars`,含註解行取代)後 `rebuildClients()` 熱重建全部 axios client + 重置 session/token/快取,**免重啟生效**。相關宣告皆為 `let` + `build*()` 工廠(unifiClient/unifiCloudClient/nasClient/nasMonClient/wiimIP);UPS 的 `UPS_SOURCE/NUT_HOST/NUT_UPS_NAME/PWRSTAT_PATH` 為呼叫時讀 env 的函式 |
| `GET /manifest.webmanifest`, `GET /sw.js` | PWA manifest 與 service worker(離線殼層快取,`/api/*` 不快取) |

### C. 雲端 Site Manager API (`https://api.ui.com/v1`,`X-API-KEY` 標頭)
| 本專案端點 | 上游端點 | 對照規格文件 §3.2 |
| :--- | :--- | :--- |
| `GET /api/cloud/sites` | `GET /v1/sites` | ✅ 正確 |
| `GET /api/cloud/devices` | `GET /v1/devices` | ✅ 正確 |
| `GET /api/cloud/hosts` | `GET /v1/hosts` | ✅ 正確 |
| `GET /api/cloud/sdwan` | `GET /v1/sd-wan-configs` | ✅ 正確 |
| `GET /api/cloud/isp-metrics` | `GET /v1/isp-metrics/5m?duration=24h` | ✅ 正確 |

### D. UGREEN NAS(UGOS Pro 原生 API,對照 `../ugreen-nas-api.md` 系統 A)
認證(UGOS Pro ≥1.17 實機驗證):`POST /ugreen/v1/verify/check?token=` → RSA 公鑰在回應標頭 `x-rsa-token`(base64 PEM;**標籤寫 RSA PUBLIC KEY 但內容是 SPKI**,需剝殼後以 der/spki 解析)→ 密碼 RSA PKCS1v15 加密 → `POST /ugreen/v1/verify/login`(`is_simple:true, keepalive:true, otp:false`)取 `data.token`。舊版 UGOS 的 `GET /verify/rsa_public_key` 作為回退。Token 快取 12 小時,後續請求掛 `?token=` query 參數。**UGOS 錯誤都回 HTTP 200,錯誤碼在 body.code**:1004/1008 = 該 API 僅限管理員帳號(disk/list、taskmgr、UPS 都要管理員;volume/list 一般帳號可讀)。

| 本專案端點 | 上游 UGOS 端點 |
| :--- | :--- |
| `GET /api/nas/overview` | `GET /ugreen/v1/sysinfo/machine/common` + `GET /ugreen/v1/taskmgr/stat/get_all` |
| `GET /api/nas/disks` | `GET /ugreen/v1/storage/disk/list?start=0&size=50` |
| `GET /api/nas/volumes` | `GET /ugreen/v1/storage/volume/list?start=0&size=50`(結果在 `data.result`) |
| `GET /api/nas/ups` | `GET /ugreen/v1/hardware/ups/config` |
| `GET /api/nas/ups-usb` | `GET /ugreen/v1/hardware/ups/usb/info` |

**注意**:UGOS 遙測回應的精確欄位名稱為逆向工程所得、未經實機驗證。後端以 `deepFind()`、前端以 `nFind()` 做防禦性鍵名匹配,NAS 頁底部附 Raw JSON 區塊 — 若實機欄位對不上,先看 Raw JSON 再調整 `nFind` 的鍵名清單。

### E. NAS Monitor 擴充 REST API(對照 `../ugreen-nas-api.md` 系統 B / nas-monitor-interface)
選填的進階資料源。設定 `NAS_MONITOR_URL` + `NAS_MONITOR_API_KEY`(標頭 `X-API-Key` 或 `Authorization: Bearer`)後啟用;未設定時全部回退展示資料。

| 本專案端點 | 上游 (System B) | 用途 |
| :--- | :--- | :--- |
| `GET /api/nas/docker` | `GET /api/docker/containers` | 容器清單 + CPU/RAM |
| `POST /api/nas/docker/:id/:action` | `POST /api/docker/containers/:id/{start\|stop\|restart}` | 容器操作 |
| `GET /api/nas/docker/:id/logs` | `GET /api/docker/containers/:id/logs` | 容器日誌 |
| `GET /api/nas/traffic-summary` | `GET /api/traffic/summary` | 今日/本週/本月流量 |
| `GET /api/nas/traffic-history` | `GET /api/traffic/history` | 流量歷史 |
| `GET /api/nas/system-history` | `GET /api/system/history` | CPU/記憶體/溫度歷史 |
| `GET /api/nas/temperature-history` | `GET /api/temperature/history` | 風扇 RPM + 硬碟溫度 |
| `GET /api/nas/storage-history` | `GET /api/storage/history` | 儲存容量趨勢 |
| `GET /api/nas/storage-forecast` | `GET /api/storage/forecast` | 滿載預估天數 |
| `GET /api/nas/downtime` | `GET /api/downtime` | 正常運行率 |
| `GET /api/nas/alerts` | `GET /api/alerts/events` | 警報事件 |
| `POST /api/nas/alerts/:id/ack` | `POST /api/alerts/events/:id/acknowledge` | 確認警報 |

NAS 頁對應區塊:進階 KPI 列(運行率/今日流量/滿載預估/Docker 數)、系統負載歷史圖、流量歷史圖、儲存趨勢圖、散熱歷史圖、Docker 容器管理表(啟停/重啟/日誌彈窗)、警報事件清單。Docker 日誌彈窗置於 `<body>` 頂層(不可放進 `backdrop-blur` 祖先內,否則 `position:fixed` 會以該祖先為定位基準而跑位)。

### F. WiiM Amp 串流音響(LinkPlay HTTP API,詳見 `wiim_spec.md`)
上游:`https://<WIIM_IP>/httpapi.asp?command=...`(自簽憑證忽略驗證,失敗自動回退 HTTP)。**必帶 `User-Agent: wiim-temp/2.0`** 繞過新韌體的 Direct IP 封鎖。唯讀命令(getPlayerStatus/getMetaInfo/getStatusEx/getPresetInfo/getbtdiscoveryresult)有 2 秒後端快取,連線失敗時回傳舊快取。

| 本專案端點 | 說明 |
| :--- | :--- |
| `GET /api/wiim/status?type=play\|status\|all` | 播放狀態+曲目 metadata / 系統資訊(溫度、遙控器電量)。裝置無回應時回退展示資料並標 `source: 'fallback'` |
| `GET /api/wiim/cmd?command=...` | 通用指令代理(播放控制/EQ/輸入源/藍牙/LED/重啟等) |
| `GET /api/wiim/history` | 溫度歷史(記憶體,上限 5000 點;**只存真實樣本**,連不上裝置時跳過取樣不偽造) |
| `GET /api/wiim/clear`, `GET /api/wiim/csv` | 清空 / 匯出溫度記錄 |

溫度輪詢為**自適應排程**(與趨勢取樣器同一套 `lastClientActivity` 判定):活躍時每 30 秒、閒置時 `trendIdleSec`。**正式後端不回退假資料**:裝置無回應時 `/api/wiim/status` 各欄位 null + `source:'unreachable'`,前端顯示「無法連線」(假資料只在 server-mock)。前端 WiiM 頁:Hero 播放卡(封面/可點擊進度條 seek/音量±/循環模式 loopmode)+ 左欄溫度監控與歷史日誌 + 右欄七分頁設定卡(音訊 DSP/EQ 含 EQGetStat 徽章/輸入源含 getPresetInfo 名稱標籤/藍牙/**串流群組**(URL 注入 play/playlist、Multiroom JoinGroupMaster、LMS、Chromecast)/運維(含 setShutdown 定時關機)/原始指令)+ 遙控器狀態卡 + **設備與網路資訊卡**(getStatusEx/getStaticIpInfo)。輪詢在 `POLL_JOBS` 註冊(`wiimSystem` 30s / `wiimPlayback` 5s，只在 WiiM 頁啟用)。遙控器欄位以 key 名稱模糊匹配。

### G. CyberPower UPS(NUT 優先多來源,對照 `cyberpower-ups-api.md`)
`UPS_SOURCE=auto` 依序嘗試:**PPB**(PowerPanel Business REST API,`PPB_HOST`/`PPB_PORT`/`PPB_USER`/`PPB_PASSWORD`,Docker 部署時 PPB_HOST 必須指向實際主機 IP 而非 127.0.0.1)→ **NUT**(`upsc <NUT_UPS_NAME>@<NUT_HOST>`,容器內需 `apk add nut`,Dockerfile 已含)→ **pwrstat**(`pwrstat -status`)→ **pmset**(`pmset -g ps`,僅容量)。以 `child_process.exec` 呼叫本地指令,無需雲端。

| 本專案端點 | 說明 |
| :--- | :--- |
| `GET /api/ups/status` | 即時讀取(來源/型號/輸入輸出電壓/電池/負載/剩餘時間/onBattery);全部失敗回 `source:'unreachable'`+lastKnown |
| `GET /api/ups/history?hours=` | 電壓/電池/負載歷史(**持久化** SQLite `history` 的 `ups` series) |
| `GET /api/ups/events` | 斷電事件(start/end/durationSec/minBattery,**持久化** SQLite `ups_events`,市電斷→開事件、恢復→補時長) |
| `GET /api/ups/csv` | 匯出電壓歷史 |

UPS 取樣(`appSettings.upsSampleSec` 預設 30s)**不做閒置降頻**——斷電/電壓紀錄無人瀏覽也要持續記錄。前端 UPS 頁:6 格 KPI(輸入/輸出電壓/電池/負載/可撐分鐘/狀態)+ 電壓歷史圖(1h/6h/24h/7d + CSV,斷電段輸入歸零)+ 電池負載圖 + 斷電事件表(進行中標紅)+ NUT 接入指南(unreachable 時顯示)。

## API 使用核對結果(對照 unifi-network-api.md)

### 符合規格
- Site Manager 的 Base URL、`X-API-Key` 標頭、`Accept: application/json` 均符合 §3.1。
- `/v1/hosts`、`/v1/sites`、`/v1/devices`、`/v1/sd-wan-configs` 路徑與方法均符合 §3.2。
- API Key 僅在後端持有,前端不直接觸碰 UniFi API,符合 §4.1。
- 回應解析採寬鬆策略(大量 `|| 0` / `|| 'Unknown'` 預設值),符合 §3.1 版本相容性要求。

### 已知偏差 / 待改進
1. **本地端點使用 Legacy API 而非新版 Integration API**:規格 §2 的本地路徑為 `/proxy/network/integration/v1/sites/{siteId}/...`(`X-API-Key` 認證);目前使用帳密登入 + `/api/s/default/...` Legacy 路徑。這是規格 §4.2 明文允許的相容作法(威脅日誌僅 Legacy 提供),但 clients/wlanconf 等未來可遷移至 Integration API。
2. **未實作分頁**:雲端列表端點未處理 `nextToken`(§3.1 游標分頁);單站點小規模部署下一頁即足夠,多主機時需補上。
3. **速率限制未處理**:未針對 HTTP 429(§3.1)實作退避重試。
4. **UniFi OS 路徑前綴注意**:若 `UNIFI_CONTROLLER_URL` 指向 UniFi OS 裝置根位址(如 UCG-Ultra),Legacy 端點實際路徑為 `/proxy/network/api/s/default/...`;目前程式碼假設 baseURL 已含該前綴,設定 `.env` 時需留意。

### 已修正(2026-07-07)
- ISP Metrics 已補上 `duration=24h` 參數,符合 §3.2。
- 封鎖客戶端已改用 `cmd/stamgr` + `block-sta`/`unblock-sta`,符合 §4.2。
- 移除未使用的 `getFirstHostId()`。
- 新增「存取控制歷史時間軸」:後端 `GET /api/block-history` + 前端時間軸卡片(位於客戶端頁下方)。定位為純監看面板,**不會**改動主控台 IDS/IPS 設定;封鎖動作與主控台為同一份狀態(`block-sta` 等同官方 Block)。
- 大改版:前端重構為側邊欄 + 7 分頁 SPA;硬體數據移除全部 Math.random 模擬,改為 SSH 兩次取樣的真實差值;新增歷史趨勢取樣器、測速結果輪詢、威脅世界地圖、Top 5 流量排行、UGREEN NAS 整合(共 6 個新後端端點)。
- 資安強化:總覽頁新增資安戰情速覽(評分環/每小時分佈/事件流);資安頁擴充 KPI 列、每小時堆疊圖、多維度 Top 分析、四重篩選 + CSV 匯出;新增自動防禦聯動(`/api/security/settings` + 後端 `autoDefenseSweep` 每 30s 掃描,偵測 Malware/Trojan/Botnet/C2 感染事件時自動 `block-sta` 隔離受感染內網設備,**預設關閉**,不改動主控台 IDS/IPS 設定,封鎖記於時間軸標記 `auto`)。

### 已修正(2026-07-10,WiiM 整合審查)
- **server-mock.js PORT 被 WiiM commit 誤改為 3000** → 還原 3005(否則與正式伺服器衝突、launch.json 失效)。
- **Tailwind `slate-750`/`slate-850` 從未定義**(全專案多處使用但 CDN 版 Tailwind 無此色階,靜默失效)→ head 加 `tailwind.config` 補上(750:#293548、850:#172033)。
- **WiiM 溫度輪詢固定 10s 永遠執行 + 連不上時偽造隨機溫度寫入歷史** → 改自適應排程 + 只記錄真實樣本。
- **播放卡無輪詢**(僅初始化與下指令後更新)→ `POLL_JOBS` 新增 `wiimPlayback`(5s)。
- 遙控器/週邊卡從左欄移至右欄(設定卡下方)平衡版面;`/api/wiim/status` 回退時補 `source` 標記;圖表範圍標籤與相對時間文案修正。

## 開發注意事項
- **歷史資料持久化**:trend/ucg/nas/ups/wiim/linux、UPS 事件與封鎖歷史皆由 `db.js` 的 SQLite WAL 管理；新增歷史型資料請沿用 `historyDb.insertPoint()`，不要重新引入整檔 JSON 寫入。
- **認證**:設 `PANEL_PASSWORD` 即啟用整站 Basic Auth；只有 `/health`、`/healthz`、`/health/ready` 免登入，完整 `/api/system/status` 仍受保護。已移除 `cors()`(前後端同源不需要)。
- **時區**:報表排程 (`reportHour`) 用本地時間,Docker 部署必須設 `TZ=Asia/Taipei`(compose 已含,Dockerfile 已裝 tzdata)。
- **`.env` 持久化**:compose 以 bind mount 掛 `./.env:/app/.env`,網頁「連線設定」的修改才能跨容器重建保留。
- `/api/hardware` 有 5 秒快取 + in-flight 去重(`getHardwareCached()`),watcher/報表直接呼叫該函式,不再自打 HTTP。
- `unifiClient` 使用 `rejectUnauthorized: false` 忽略自簽憑證 — 僅限內網使用。
- 所有雲端端點錯誤時回退 mock 資料並回 200(`source: 'fallback_on_error'`),前端不會看到 5xx;除錯時檢查回應中的 `source` 與 `error` 欄位。
- Site Manager 遠端速率限制:EA 每分鐘 100 次(§1),輪詢頻率設計時需考量。
