# SmartHub 後端地圖

`server.js` 是正式後端組裝入口；可觀測性拆在 `observability/*.js`，SQLite 包裝層在 `db.js`，可測試的整合／中介層／政策／工作／服務邊界在 `server/`。後端任務先用這份符號／路由索引定位，再讀小區段；不要保存會隨功能漂移的行號。

## 主要區段

| 搜尋錨點 | 區段 | 內容 |
|---|---|---|
| `createAppLogger`, `apiError` | 啟動與共用工具 | 結構化記錄器、錯誤代碼、請求脈絡、面板 Session／Basic 相容、API 錯誤契約 |
| `unifiLogin`, `createSiteManagerClient` | UniFi 用戶端 | 本機控制器登入／cookie、有界雲端用戶端 |
| `/api/hardware` | UCG 硬體 | 透過 SSH 取得 CPU／記憶體／磁碟／網路資料 |
| `/api/clients`, `/api/wifi-networks`, `/api/threats` | UniFi 網路 | 用戶端、交換器、WiFi、威脅事件 |
| `DATA_DIR`, `historyDb` | 資料／資料庫／設定 | SQLite、SystemMonitor、應用程式設定、啟動時分階段還原 |
| `/api/device/restrict`, `/api/poe/power-cycle`, `/api/speedtest` | 用戶端控制 | 別名、封鎖／解除封鎖、PoE、網路測速 |
| `/api/cloud/sites` | Site Manager | 雲端站點／裝置／ISP／主機／SD-WAN |
| `securitySettings`, `threatBlockingService` | 安全性 | 安全設定、自動防禦、暫時性公開 IP 封鎖 |
| `notificationSettings`, `reportRunner` | 通知／排程器 | 設定、派送、監看器、工作追蹤、耐久報告工作 |
| `activityLease`, `/api/history` | 趨勢歷史 | 自適應取樣、歷史資料、可見性心跳 |
| `nasLogin`, `/api/nas/overview` | UGOS NAS | NAS auth/token、overview、disks、logs、UPS |
| `/api/hardware/history`, `/api/nas/history` | UCG／NAS 歷史 | 硬體與 NAS 歷史樣本 |
| `nasMonitorClient`, `/api/nas/stream` | NAS 監視器 | Docker、流量、警示、有界 SSE 串流 |
| `CONN_FIELDS`, `configBackupService` | 設定／連線／復原 | `/api/settings`、`.env` 持久化、備份／還原、用戶端重建 |
| `reportRunner`, `registerPwaRoutes` | 報告／PWA | 報告建置器／排程器、manifest、service worker |
| `wiimRequest`, `/api/wiim/status` | WiiM | 型別化 LinkPlay 代理、狀態、歷史、封面、CSV |
| `readUpsLive`, `/api/ups/status` | UPS | PPB／NUT／pwrstat／pmset、狀態／歷史／事件／CSV |
| `adGuardClient`, `/api/adguard/overview` | AdGuard | 有界傳輸、概覽、查詢記錄、防護／政策 |
| `/api/linux/stats` | Linux 主機 | SSH 統計、歷史 |
| `registerHealthRoutes` | 健康狀態 | 存活、就緒、系統診斷 |
| `startServer`, `shutdown` | 啟動／錯誤 | 外部診斷、API 錯誤處理器、監聽、停止／崩潰處理器 |

## API 端點快查

### UniFi / UCG

- `GET /api/hardware`
- `GET /api/clients`
- `GET /api/network/switches`
- `GET /api/wifi-networks`
- `PUT /api/wifi-networks/:id`
- `GET /api/threats`
- `GET/POST /api/security/threat-blocks`、`DELETE /api/security/threat-blocks/:id`（僅限管理員；公網 IPv4、強制到期、SQLite 期望狀態／稽核、UniFi 專用流量清單協調）
- `PUT /api/device/restrict`
- `POST /api/poe/power-cycle`
- `POST /api/speedtest`
- `GET /api/speedtest/status`
- `GET /api/hardware/history`

### Cloud Site Manager

- `GET /api/cloud/sites`
- `GET /api/cloud/devices`
- `GET /api/cloud/isp-metrics`
- `GET /api/cloud/hosts`
- `GET /api/cloud/sdwan`

### NAS / NAS Monitor

- `GET /api/nas/overview`
- `GET /api/nas/disks`
- `GET /api/nas/disk-smart`
- `GET /api/nas/logs`
- `GET /api/nas/sleep-stats`
- `GET /api/nas/volumes`
- `GET /api/nas/ups`
- `GET /api/nas/docker`
- `POST /api/nas/docker/:id/:action`
- `GET /api/nas/docker/:id/logs`
- `GET /api/nas/alerts`
- `GET /api/nas/stream`

### 通知／設定／報告

- `GET/POST /api/notifications/settings`
- `POST /api/notifications/test`
- `GET /api/notifications/log`
- `GET /api/web-push/config`、`POST/DELETE /api/web-push/subscriptions`：公開 VAPID metadata、僅限管理員的持久瀏覽器訂閱生命週期；私鑰永不回傳
- `GET/POST /api/settings`
- `GET/POST /api/connections`
- `GET /api/config/backup`, `GET /api/config/backup/status`, `POST /api/config/restore`（僅限管理員；還原使用專用 media type，並於重新啟動時套用）
- `POST /api/reports/run`
- `GET /api/reports/log`（由 SQLite 持久保存的報告產生與送達記錄）

### WiiM / UPS / AdGuard / Linux

- `GET /api/wiim/status`
- `GET /api/wiim/cmd`（只保留型別化讀取相容性；異動操作使用受保護的 POST 路由）
- `GET /api/wiim/art`
- `GET /api/ups/status`
- `GET /api/ups/history`
- `GET /api/ups/events`
- `GET /api/adguard/overview`
- `GET /api/adguard/querylog`、`POST /api/adguard/protection`：共用 `server/integrations/adguard-client.js`；HTTPS 預設驗證、遠端 HTTP 必須明確選用、禁止重新導向／代理轉送憑證
- `GET/POST /api/adguard/service-policies`、`DELETE /api/adguard/service-policies/:id`：僅限管理員的每裝置服務封鎖期望狀態、基準還原、SQLite 稽核與有界協調
- `GET /api/linux/stats`
- `GET /api/linux/history`

### 健康狀態／診斷

- `GET /health` / `/healthz` / `/health/ready`
- `GET /api/public/system-health`（匿名唯讀；只回傳既有記憶體摘要的狀態、總數、在線／離線數與 `snapshotAt`；不觸發設備探測）
- `GET /api/system/status`
- 模組：`observability/logger.js`、`system-monitor.js`、`issue-tracker.js`、`task-tracker.js`、`health-routes.js`

### 復原服務

- `server/services/config-backup.js`：不洩漏機密的匯出、產物／hash／schema 驗證、分階段還原、啟動回滾交易
- `db.js#createHistoryDb().backup()`：先寫入待處理遙測資料，再建立一致的 SQLite 備份快照

### 威脅 IP 封鎖

- `server/policies/threat-ip-policy.js`: 公網 IPv4／管理位址／到期／二次確認契約
- `server/integrations/unifi-traffic-list-client.js`：官方 Network Integration API 流量清單身分與完整 PUT
- `server/services/threat-ip-blocking.js`：序列化異動／協調、持久重試退避、到期移除
- `db.js`：`threat_ip_blocks` 期望狀態與有界 `threat_ip_block_audit`

### 前端執行期信任邊界

- `server/routes/frontend-asset-routes.js`：只公開由 lockfile 鎖定且 URL 帶版本的 Chart／D3／TopoJSON／world-atlas 檔案，並集中設定 CSP／防框架／referrer headers
- `server/routes/panel-auth-routes.js` + `server/middleware/panel-security.js`：公開登入資產、匿名核心快照與同源登入／登出／狀態端點；HttpOnly SameSite Session、登入節流、角色、per-session CSRF，並保留 Basic Auth 相容
- `server/services/public-system-health.js`：有界匿名快照與獨立來源限流；HTTP handler 只讀保留在記憶體的固定五欄資料，不執行 Ping、SSH、設備 API 或資料庫聚合
- `server/services/wifi-qr.js`：同源訪客 WiFi QR SVG；不把 SSID／密碼送往第三方
- `POST /api/wifi/qr`：僅限管理員、Origin／CSRF、嚴格 SSID／WPA 驗證、`no-store`

### AdGuard 傳輸邊界

- `server/integrations/adguard-client.js`：有界來源／憑證／CA／逾時政策，固定 `/control/*` 請求範圍，Basic Auth 只送往已驗證的設定來源
- `/api/connections`：寫入任何 `ADGUARD_*` 欄位前先組合候選設定並採 fail-closed；`ADGUARD_URL` 優先，舊 `ADGUARD_HOST/PORT` 僅保留相容性

### AdGuard 各裝置服務政策

- `server/policies/adguard-service-policy.js`：IP／MAC、YouTube／TikTok／遊戲受控定義、IANA 時區與每日允許時段契約；允許時段是 AdGuard 服務封鎖篩選的停用期間
- `server/services/adguard-service-policy.js`：序列化各裝置協調、支援上游 client／catalog 兩種回應形狀、保留非管理欄位、首次基準擷取、移除時還原、有界重試／漂移修復
- `db.js`：`adguard_service_policies` 期望狀態／重試／基準，以及有界 `adguard_service_policy_audit`

### Web Push

- `server/routes/web-push-routes.js`：正式／mock 共用精確 GET／POST／DELETE 契約、輸入政策與管理員 middleware 插槽；執行期專用的服務／錯誤轉接器由組裝入口注入
- `server/policies/web-push-policy.js`：精確 HTTPS 訂閱、P-256／auth key、相符 VAPID tuple 與同源可見 payload 契約
- `server/services/web-push.js`：SQLite 訂閱、24 小時送達 claims、有界並行／重試／退避、404／410 清理；endpoint 只以 hash 寫入 log
- `server/services/pwa-service-worker.js`：正式／mock 共用 shell cache、可見 push 與同源通知點擊 renderer
- `server/integrations/notification-delivery.js`：Web Push 是額外 fan-out；主要通道的部分送達歧義不可被 fallback 覆寫
- `db.js`：`web_push_subscriptions` 與有界 `web_push_delivery_claims`

### 長期通知／失敗狀態

- `server/services/auto-defense-block-state.js`：Auto Defense 成功封鎖後 10 分鐘傳播冷卻；標準化 MAC、拒絕未來警報、2,000 項近期資料上限，到期後允許新事件重新隔離
- `server/services/docker-notification-state.js`：Docker CPU／RAM 冷卻的單一 owner；容器移除清理加上 2,000 項近期資料上限
- `server/services/recoverable-failure-state.js`：整合失敗 log 冷卻的單一 owner；保留首次記錄／冷卻語意，支援動態 Docker key 移除及 2,000-key 上限

### 可變設定耐久性

- `server/storage/json-file-store.js`：應用程式、UI 偏好、用戶端別名、安全、通知 JSON 的有界純物件 reader，以及同目錄 0600 暫存檔＋fsync＋atomic rename writer；API 先落盤再發布即時狀態
- `server/storage/instance-lock.js`：DATA_DIR 的交易式 SQLite 租約 owner；雜湊 runtime／container 身分＋PID／token、`IMMEDIATE` claim／reclaim、2 秒心跳／8 秒租約、舊 PID migration、精確 owner 釋放，失去 owner 時採 fail-safe shutdown

### SSH 命令生命週期

- `server/integrations/ssh-command-stream.js`：UCG／Linux 單次命令串流的 12 秒期限、1 MiB 合併 stdout／stderr 上限、中止，以及 listener／timer 清理

## 搜尋範例

```bash
rg -n "app\\.(get|post|put).*ups|readUpsLive|sampleUps" server.js
```
