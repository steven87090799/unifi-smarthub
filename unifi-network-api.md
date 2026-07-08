# UniFi Network API (v10.3.58) 核心技術摘要與開發指引

此文件為 UniFi 網路控制器 API 整合與二次開發的技術規格手冊。任何開發工具、協作 AI（如 Claude Code、ChatGPT）或人類開發者皆可參考此文件進行開發。

---

## 1. 連線模式比較 (Local vs. Remote)

開發客製化控制面板前，需依據部署環境選擇連線模式：

| 比較維度 | Local (本地連線) | Remote (雲端連線 / Cloud Connector) |
| :--- | :--- | :--- |
| **基礎 URL** | `https://<local-ip>/proxy/network/integration/v1/` | `https://api.ui.com/v1/connector/consoles/{consoleId}/proxy/network/integration/v1/` |
| **認證來源** | 控制器本地介面建立的 API Key | unifi.ui.com 建立的 Site Manager API Key |
| **系統限制** | 無硬性限制，適合高頻率輪詢 | 每分鐘最高 100 次請求、請求需於 25 秒內完成、回應上限 10MB |
| **韌體要求** | 無特殊限制 | 遠端控制器韌體需 >= 5.0.3 |
| **適用場景** | 網頁伺服器佈署於地端內網、需要即時監控 | 跨越 NAT 集中管理多站點、多租戶架構 |

---

## 2. API 端點總表 (v10.3.58)

### 通用請求規則
- **標頭 (Headers)**: `X-API-Key: <Your_Key>` 與 `Accept: application/json`。
- **列表查詢 (GET)**: 支援過濾參數 `?filter=`。可用屬性如 `id.eq(...)`、邏輯如 `and(...)` 或反向 `not(...)` 進行進階篩選。

### 站點與網路架構 (Sites & Networks)
| API 分類 | HTTP 方法 | 端點路徑 | 說明 |
| :--- | :--- | :--- | :--- |
| 列出站點 | GET | `/v1/sites` | 獲取 `siteId`，此為所有後續操作的必要參數。 |
| 網路 CRUD | 多種 | `/v1/sites/{siteId}/networks[/...]` | 建立/修改 VLAN 與 DHCP Guarding 狀態。 |

### 硬體與客戶端 (Devices & Clients)
| API 分類 | HTTP 方法 | 端點路徑 | 說明 |
| :--- | :--- | :--- | :--- |
| 設備管理 | GET/POST | `/v1/sites/{siteId}/devices[/...]` | 查詢線上設備清單、韌體版本與執行納管。 |
| 客戶端查詢 | GET | `/v1/sites/{siteId}/clients` | 獲取連線終端的 IP、MAC、類型與連線時間戳記。 |
| 客戶端指令 | POST | `/v1/sites/{siteId}/clients/{clientId}/action` | 對特定設備下達動作（例如斷網封鎖）。 |

### 資訊安全與流量控制 (Security & Control)
| API 分類 | HTTP 方法 | 端點路域 | 說明 |
| :--- | :--- | :--- | :--- |
| 防火牆策略 | 多種 | `/v1/sites/{siteId}/firewall/policies[/...]` | 詳細定義允許/阻擋規則。支援用 `PATCH` 快速切換 `enabled` 狀態。 |
| 流量比對清單 | 多種 | `/v1/sites/{siteId}/traffic-matching-lists[/...]` | 定義 IP 或網域名稱群組，用於防火牆動態更新。 |
| 存取控制(ACL) | 多種 | `/v1/sites/{siteId}/acl/rules[/...]` | 設定 L2/L3 交換器層級的安全規則。 |

### 其它進階功能
| API 分類 | HTTP 方法 | 端點路徑 | 說明 |
| :--- | :--- | :--- | :--- |
| 訪客憑證 | 多種 | `/v1/sites/{siteId}/hotspot/vouchers[/...]` | 用於與 POS 系統整合，動態生成或刪除 WiFi 訪客密碼。 |
| DNS 策略 | 多種 | `/v1/sites/{siteId}/dns/policies[/...]` | 內部 DNS 解析與特定網域阻擋。 |

---

## 3. Site Manager API (v1.0.0) 機器可讀參考手冊

### 3.1 核心整合規範 (Global Configuration)
- **Base URL**: `https://api.ui.com`
- **Authentication**: HTTP 請求標頭需包含 `X-API-Key: <API_KEY>` (無狀態驗證)
- **Content-Type / Accept**: `application/json`
- **Rate Limits**: 官方 v1 版本每分鐘 10,000 次；EA 測試版每分鐘 100 次。超過限制時回傳 HTTP 429。
- **Pagination (分頁)**: 採用游標分頁。透過 Query 參數傳遞 `pageSize` (上限 500) 與 `nextToken`。當回應中無 `nextToken` 時代表資料檢索完畢。
- **Response Format (回應格式)**: 成功與失敗皆回傳標準 JSON。固定包含頂層欄位 `httpStatusCode`、`traceId`、`data` (核心酬載)。發生錯誤時會包含 `code` 與 `message` 欄位。
- **Version Control**: API 具備向前相容性。系統解析 JSON 時應實作寬鬆解析策略，允許未記載的屬性或 null 值。

### 3.2 API 端點總表 (Endpoints)
| API Name | Method | Endpoint Path | Parameters (Path/Query/Body) | Response Schema (data) |
| :--- | :--- | :--- | :--- | :--- |
| List Hosts | GET | `/v1/hosts` | Query: `pageSize` (string), `nextToken` (string) | Array of object, 包含 `nextToken` |
| Get Host by ID | GET | `/v1/hosts/{id}` | Path: `id` (string, required) | Object |
| List Sites | GET | `/v1/sites` | Query: `pageSize` (string), `nextToken` (string) | Array of object, 包含 `nextToken` |
| List Devices | GET | `/v1/devices` | Query: `hostIds[]` (Array of string), `time` (string, RFC3339), `pageSize`, `nextToken` | Array of object, 包含 `nextToken` |
| Get ISP Metrics | GET | `/v1/isp-metrics/{type}` | Path: `type` (string, 5m 或 1h)<br>Query: `beginTimestamp` (RFC3339), `endTimestamp` (RFC3339), `duration` (支援 24h, 7d, 30d) | Array of object |
| Query ISP Metrics | POST | `/v1/isp-metrics/{type}/query` | Path: `type` (string, 5m 或 1h)<br>Body: `sites` (Array of object, 需含 `hostId`, `siteId`, `beginTimestamp`, `endTimestamp`) | Object |
| List SD-WAN Configs | GET | `/v1/sd-wan-configs` | 無 | Array of object |
| Get SD-WAN Config by ID | GET | `/v1/sd-wan-configs/{id}` | Path: `id` (string, required) | Object |
| Get SD-WAN Config Status | GET | `/v1/sd-wan-configs/{id}/status` | Path: `id` (string, required) | Object |

---

## 4. 開發實務與 IDS/IPS 自動化防禦整合

### 4.1 基礎系統架構要求
客製化管理網頁必須採用**「前後端分離」**架構。前端不可直接呼叫 UniFi API，應由後端中介層保管 `X-API-Key` 並負責發送請求，以確保高權限金鑰不外洩。

### 4.2 IDS/IPS 主動防禦聯動邏輯
針對入侵偵測 (IDS) 與防禦 (IPS)，可透過 API 實現高度自動化的「感知與阻擋」機制：

1. **威脅事件輪詢 (感知)**：
   由於官方新版 API 尚未完全涵蓋底層威脅日誌，後端程式可輪詢舊版相容性 API 端點（如 `GET /api/s/{site}/stat/event` 或相關 threat 路徑），以取得 Suricata 引擎觸發的威脅事件（包含攻擊來源 IP、受感染內網 MAC 等數據）。
2. **內網受感染設備隔離 (對內)**：
   若 IDS 發現內網有設備遭到木馬控制或異常行為，後端系統立即呼叫客戶端指令 API，傳入 `{"cmd": "block-sta", "mac": "<受感染MAC>"}`，將其從交換器或 WiFi 上強制斷網。
3. **動態防火牆即時阻擋 (對外)**：
   - 預先在防火牆策略中建立一條阻擋規則，其目標指向一個「自動威脅封鎖群組」的 `Traffic Matching List`。
   - 當偵測到外部惡意 IP（如 SSH 爆破攻擊）時，後端直接透過 `PUT /v1/sites/{siteId}/traffic-matching-lists/{listId}` 將該 IP 加入清單中。
   - 系統可瞬間生效，無需反覆重寫複雜的防火牆規則，極大化降低運算成本。
