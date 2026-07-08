# 綠聯 (UGREEN) UGOS Pro NAS & NAS Monitor 系統 API 參考指南

**重要聲明**： 本文件包含逆向工程所得的「綠聯 UGREEN UGOS Pro NAS」底層硬體 API，以及 nas-monitor-interface 專案所提供的中介層 REST API。此結構化文件專為 AI 閱讀與對照呼叫設計。

---

## 系統 A：綠聯 UGOS Pro 原生 API (NAS 底層通訊)

此部分為直接向 UGREEN NAS 發送請求的端點。

### 1. 全域請求標頭與認證要求
所有對 `ugreen/v1/*` 的請求都必須包含以下資訊，否則將被伺服器拒絕：
- **Header** `ug-agent`: `PC/WEB` (強制必須)
- **Header** `Accept`: `application/json`
- **Query Parameter** `token`: `?token=<token>` (除了取得公鑰與登入端點外，其餘皆必須提供)

### 2. 身分驗證端點 (Authentication)
密碼必須使用伺服器公鑰透過 RSA PKCS1v15 進行加密，並 Base64 編碼。

| Method | Endpoint | Description | Request Body / Payload |
| :--- | :--- | :--- | :--- |
| GET | `/ugreen/v1/verify/rsa_public_key` | 獲取 RSA 公鑰 | 無 |
| POST | `/ugreen/v1/verify/login` | 登入並獲取 Token | `{"username":"<user>","password":"<encrypted>","device_type":1}` |
| POST | `/ugreen/v1/verify/token/refresh` | 刷新 Token (有效期 24H) | Header 需帶 `Authorization: Bearer <token>` |

### 3. 系統遙測與狀態端點 (System & Telemetry)
| Method | Endpoint | Description | Response Data Highlight |
| :--- | :--- | :--- | :--- |
| GET | `/ugreen/v1/sysinfo/machine/common` | 硬體/韌體基本資訊 | 回傳 `model`, `firmware_version`, `cpu_model`, 網路介面 |
| GET | `/ugreen/v1/taskmgr/stat/get_all` | 即時監控總數據 (核心端點) | 回傳 CPU/RAM 負載、網路即時收發 Bytes、硬碟/儲存區即時 IO |

* **備註**：舊版 UGOS 支援 WebSocket 即時推送 (`wss://<IP>:9443/ugreen/v1/taskmgr/wss/subscribe`)，但自韌體 1.14.x 起已被原廠移除 (回傳 404)。

### 4. 儲存子系統端點 (Storage)
| Method | Endpoint | Query Parameters | Description |
| :--- | :--- | :--- | :--- |
| GET | `/ugreen/v1/storage/disk/list` | `start=0, size=50` | 實體硬碟清單 (包含溫度、健康狀態 "Good") |
| GET | `/ugreen/v1/storage/volume/list` | `start=0, size=50` | 邏輯儲存區清單 (回傳資料包裝於 `data.result` 內) |

### 5. 硬體與 UPS 端點 (Hardware)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| GET | `/ugreen/v1/hardware/ups/usb/info` | 實體 USB UPS 快速存在性檢查 |
| GET | `/ugreen/v1/hardware/ups/config` | 獲取 UPS 設定與即時電池電量/可用時間 (支援 USB & SNMP) |

---

## 系統 B：NAS Monitor 擴充 REST API (中介層)

此部分為 nas-monitor-interface 後端 (Flask) 提供給儀表板與 Home Assistant 呼叫的 API。

### 1. 認證要求
除 `/api/auth/*` 外，呼叫所有 `/api/*` 端點皆需驗證：
- **Header 認證**：`X-API-Key: <key>` 或 `Authorization: Bearer <key>`
- **狀態變更保護**：若使用 Cookie Session 認證，對應的 `POST/DELETE` 請求需帶有 `X-CSRF-Token` 標頭。

### 2. 即時狀態與串流 (Real-Time & Stream)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| GET | `/api/status` | NAS 與 Docker 連線基本狀態 |
| GET | `/api/current` | 獲取最新的記憶體遙測快照 (經修剪與標準化) |
| GET | `/api/ups` | 從收集器快照中提取 UPS 電池與連線狀態字典 |
| GET | `/api/stream` | 建立 Server-Sent Events (SSE) 即時資料推送連線 |

### 3. 時間序列與歷史分析 (History & Analytics)
| Method | Endpoint | Parameters | Description |
| :--- | :--- | :--- | :--- |
| GET | `/api/system/history` | `hours=24` | CPU、記憶體使用率與溫度歷史 |
| GET | `/api/temperature/history` | `hours=24` | 散熱數據 (風扇 RPM、個別硬碟溫度 JSON 陣列) |
| GET | `/api/traffic/history` | `hours=24` | 網路傳輸歷史紀錄 |
| GET | `/api/traffic/summary` | 無 | 聚合查詢今日、本週、本月之總網路流量 |
| GET | `/api/storage/history` | `hours=720` | 長期儲存空間容量變化趨勢 |
| GET | `/api/storage/forecast` | `days=30` | 基於線性迴歸估算儲存池滿載之剩餘天數 |
| GET | `/api/users/history` | `hours=720` | 追蹤個別使用者之儲存容量佔用與檔案數增長 |
| GET | `/api/downtime` | `days=30` | 獲取 NAS 離線事件摘要與 uptime_percent |

### 4. Docker 管理與警報控制 (Docker & Alerts)
| Method | Endpoint | Parameters | Description |
| :--- | :--- | :--- | :--- |
| GET | `/api/docker/containers` | 無 | 獲取所有容器狀態及即時 CPU/RAM 佔用統計 |
| POST | `/api/docker/containers/<id>/start` | 無 | 啟動指定容器 (60秒內限30次請求) |
| POST | `/api/docker/containers/<id>/stop` | 無 | 停止指定容器 (帶有 10 秒 Timeout) |
| POST | `/api/docker/containers/<id>/restart` | 無 | 重啟指定容器 |
| GET | `/api/docker/containers/<id>/logs` | `lines=200` | 獲取指定容器日誌 |
| GET | `/api/alerts/config` | 無 | 獲取所有自訂警報閾值設定 |
| POST | `/api/alerts/config` | 無 | 建立或更新指定指標的警報設定 |
| DELETE | `/api/alerts/config/<metric>` | 無 | 刪除指定指標的警報設定 |
| GET | `/api/alerts/events` | `hours=24` | 獲取近期觸發的系統警報事件日誌 |
| POST | `/api/alerts/events/<id>/acknowledge` | 無 | 確認並清除指定警報活動 |

---

## 系統部署環境變數 (Environment Variables)

配置此系統所需注入的變數清單 (通常透過 `.env` 或 `docker-compose` 注入)：

| Variable | Required | Default | AI Context / Description |
| :--- | :--- | :--- | :--- |
| `NAS_HOST` | Yes | 無 | 綠聯 NAS 設備之 IP 或 Hostname |
| `NAS_USER` | Yes | `monitor` | UGOS 系統管理員帳號 (密碼不可含 `#`, `*`, `§`) |
| `NAS_PASSWORD_FILE` | Yes | 無 | 指向存放 UGOS 密碼的 Docker Secret 路徑 |
| `NAS_MONITOR_API_KEY_FILE` | Yes | 無 | 指向存放 Dashboard API 授權金鑰的路徑 |
| `NAS_PORT` | No | `9443` | UGOS API HTTPS 監聽連接埠 |
| `NAS_SCHEME` | No | `https` | 與 NAS 通訊之協定 (`http` 或 `https`) |
| `POLL_INTERVAL` | No | `15` | 背景收集器向 NAS 發起 REST API 輪詢之間隔秒數 |
| `WS_ENABLED` | No | `false` | 是否啟用 UGOS 舊版 WebSocket 端點連線 |
| `TOKEN_PROXY_METHOD` | No | `POST` | 與 Token Proxy 通訊的 HTTP Method (遇到 405 時可改 GET) |
| `TZ` | No | `UTC` | 系統時區 (如 `Asia/Taipei`) |
