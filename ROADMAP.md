# SmartHub 未使用 API 盤點與功能路線圖

> 產生日期:2026-07-12。對照 5 份規格文件與 `server.js` 實際用量,加上已整合服務(AdGuard / PPB)的可深挖空間。
> ⭐ = 建議優先做。

---

## 一、各來源尚未使用的 API

### 1. UniFi 本地 Integration API(`unifi-network-api.md` §2)— 整份未用
目前全部走 Legacy API(帳密 + Cookie)。Integration API 用 `X-API-Key`,路徑 `/proxy/network/integration/v1/...`。

| 端點 | 能做什麼 | 價值 |
|---|---|---|
| `traffic-matching-lists` | 動態 IP/網段封鎖清單 — 可把 IPS 偵測到的**對外惡意 IP 直接封鎖**(現有自動防禦只能封內網 MAC) | ⭐⭐⭐ |
| `firewall/policies`(PATCH enabled) | 面板一鍵開關防火牆規則(如「客廳電視斷網時段」) | ⭐⭐ |
| `dns/policies` | 閘道器層級網域阻擋 / 內部 DNS 記錄 | ⭐ |
| `hotspot/vouchers` | 訪客 WiFi 憑證產生/撤銷(配 QR code 顯示) | ⭐⭐ |
| `networks`、`acl/rules` | VLAN 清單、ACL 規則管理 | ○ |

### 2. Site Manager 雲端
- `GET /v1/sd-wan-configs/{id}/status`:SD-WAN 健康下鑽
- `POST /v1/isp-metrics/query`、`/isp-metrics/1h`:自訂區間 ISP 歷史(現固定 5m/24h)
- `nextToken` 游標分頁未處理(多主機部署才需要)

### 3. UGREEN NAS(系統 A)
實作已反超規格(自行逆向了 log/query、smart/info)。僅剩 `POST /verify/token/refresh` 未用,現行 12h 重登機制已足夠,**免做**。

### 4. NAS Monitor(系統 B,選配)
| 端點 | 能做什麼 | 價值 |
|---|---|---|
| `GET /api/stream`(SSE) | 即時推送取代輪詢,降低 NAS 負擔 | ⭐⭐ |
| `GET/POST/DELETE /api/alerts/config` | 面板直接管理警報閾值(現在只能看不能改) | ⭐⭐ |
| `GET /api/users/history` | 各使用者容量成長追蹤 | ○ |
| `/api/status`、`/api/current`、`/api/ups` | 與 UGOS 直連重疊,免做 | ✕ |

### 5. WiiM Amp
| 指令 | 能做什麼 | 價值 |
|---|---|---|
| `setAlarmClock` | **硬體鬧鐘**:定時自動播放電台/歌單(起床音樂) | ⭐⭐ |
| `EQChangeSourceFX` / `EQSourceOff` | 各輸入源獨立 PEQ 等化器 | ⭐ |
| `getChannelBalance` 等回讀指令 | 設定卡目前只寫不讀,UI 無法回顯現值 | ○ |
| `setWlanStaticIp` | 改裝置網路設定 — 風險高,**不建議** | ✕ |

### 6. CyberPower UPS / PowerPanel Business
- PPB REST 還有:電池自檢排程、輸出插座(outlet)群組控制、關機動作設定 — 規格文件未載,需另行逆向抓包
- macOS IOKit `IOPS` 原生讀取:免 subprocess 取代 pmset(部署到 Linux 後無意義,**免做**)
- `cyberpower-usb-watcher`(HID 直讀):可作為 NUT 之外的備援來源

### 7. AdGuard Home(已整合,可深挖)
| 端點 | 能做什麼 | 價值 |
|---|---|---|
| `blocked_services` | **一鍵封鎖 YouTube / TikTok / 遊戲等服務**(officially 支援上百種),可加排程 → 家長管控殺手級功能 | ⭐⭐⭐ |
| `/control/clients` | 每設備獨立過濾設定(小孩的平板嚴格、自己的電腦寬鬆) | ⭐⭐ |
| `filtering/*` | 自訂攔截規則、訂閱清單管理(從面板直接加黑名單網域) | ⭐⭐ |
| `rewrite/*` | 本地 DNS 改寫(內網服務域名,如 nas.home → 192.168.0.91) | ⭐ |
| `parental` / `safebrowsing` / `safesearch` | 家長管控三開關 | ⭐ |
| `access` | per-client 允許/封鎖清單 | ○ |

---

## 二、建議功能路線圖

### 近期(價值高、工作量小)
1. **AdGuard 服務封鎖面板** ⭐⭐⭐:在 AdGuard 頁加「服務封鎖」卡,一鍵封 YouTube/TikTok/IG,配合排程(平日晚上 10 點後自動封);與客戶端自訂名稱整合做 per-client 管控。
2. **威脅事件點擊封鎖來源 IP** ⭐⭐⭐:資安頁事件表加按鈕,把對外攻擊 IP 寫入 UniFi `traffic-matching-lists` 直接在閘道器封鎖;自動防禦同步升級(內網隔離 + 外網封 IP 雙管齊下)。
3. **WiiM 鬧鐘排程**:設定頁加起床音樂排程(`setAlarmClock`)。
4. **訪客 WiFi 憑證**:WiFi 頁加「產生訪客憑證」按鈕 + QR code(現有 qrserver CDN 已在用)。

### 中期
5. **每設備 DNS 管控頁**:AdGuard `/control/clients` + 面板客戶端別名,做出「這台平板:安全搜尋開、遊戲封鎖、晚上斷 YouTube」的統一管控介面。
6. **防火牆規則開關卡**:UCG 頁列出 firewall policies,一鍵啟停。
7. **報表圖表化**:定期報表附迷你趨勢圖(QuickChart URL 或 SVG 內嵌),Discord/Telegram 顯示圖片。
8. **Web Push 通知**:PWA 已就緒,補 service worker push + VAPID,手機不裝 Discord 也能收警報。

### 長期 / 架構
9. **SQLite 取代 JSON**:歷史資料量放大後(30 天 × 6 系列),JSON 全檔重寫的成本會越來越高;SQLite 單檔可掛同一 volume,查詢也快。
10. **SSE/WebSocket 即時推送**:前端輪詢 12 項改為伺服器推送,行動裝置更省電。
11. **多使用者/唯讀模式**:現有 Basic Auth 是單密碼全權限;可加唯讀訪客密碼(給家人看狀態、不能封鎖設備)。
12. **設定備份/還原**:一鍵匯出 `data/*.json` + `.env`(遮罩機密)的 zip,部署搬遷更輕鬆。

---

## 三、明確「不做」清單
- UGOS WebSocket 遙測:原廠已移除,死路。
- `setWlanStaticIp` 等改裝置網路的指令:改壞會失聯,風險 > 效益。
- 系統 B 與 UGOS 直連重疊的端點(`/api/status`、`/api/ups`):重複資訊。
- PPB 舊版 port 3052 (`ppbe.js`) 介面:已被 `/local/rest/v1` 完全覆蓋。
