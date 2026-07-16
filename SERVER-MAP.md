# SmartHub Backend Map

`server.js` 是正式後端組裝入口；可觀測性拆在 `observability/*.js`，SQLite wrapper 在 `db.js`，可測試的整合／middleware／policy／job／service 邊界在 `server/`。後端任務先用這份 symbol/route 索引定位，再讀小區段；不要保存會隨功能漂移的行號。

## 主要區段

| 搜尋錨點 | 區段 | 內容 |
|---|---|---|
| `createAppLogger`, `apiError` | 啟動與共用工具 | structured logger、error code、request context、Basic Auth、API error contract |
| `unifiLogin`, `createSiteManagerClient` | UniFi clients | 本地 controller login/cookie、bounded Cloud client |
| `/api/hardware` | UCG hardware | SSH 取 CPU/記憶體/磁碟/網路 |
| `/api/clients`, `/api/wifi-networks`, `/api/threats` | UniFi Network | clients、switches、WiFi、threats |
| `DATA_DIR`, `historyDb` | Data / DB / settings | SQLite、SystemMonitor、app settings、啟動時 staged restore |
| `/api/device/restrict`, `/api/poe/power-cycle`, `/api/speedtest` | Client controls | alias、block/unblock、PoE、speedtest |
| `/api/cloud/sites` | Site Manager | cloud sites/devices/ISP/hosts/SD-WAN |
| `securitySettings`, `threatBlockingService` | Security | security settings、auto defense、temporary public-IP blocks |
| `notificationSettings`, `reportRunner` | Notifications / scheduler | settings、dispatch、watchers、task trace、durable report jobs |
| `activityLease`, `/api/history` | Trend history | adaptive sampling、history、visibility heartbeat |
| `nasLogin`, `/api/nas/overview` | UGOS NAS | NAS auth/token、overview、disks、logs、UPS |
| `/api/hardware/history`, `/api/nas/history` | UCG/NAS history | hardware and NAS historical samples |
| `nasMonitorClient`, `/api/nas/stream` | NAS Monitor | docker、traffic、alerts、bounded SSE stream |
| `CONN_FIELDS`, `configBackupService` | Settings/connections/recovery | `/api/settings`、`.env` persistence、backup/restore、client rebuild |
| `reportRunner`, `registerPwaRoutes` | Reports/PWA | report builder/scheduler、manifest、service worker |
| `wiimRequest`, `/api/wiim/status` | WiiM | typed LinkPlay proxy、status、history、art、CSV |
| `readUpsLive`, `/api/ups/status` | UPS | PPB/NUT/pwrstat/pmset、state/history/events/CSV |
| `adGuardClient`, `/api/adguard/overview` | AdGuard | bounded transport、overview、querylog、protection/policies |
| `/api/linux/stats` | Linux host | SSH stats、history |
| `registerHealthRoutes` | Health/status | liveness、readiness、system diagnostics |
| `startServer`, `shutdown` | Startup / errors | external diagnostics、API error handler、listen、shutdown/crash handlers |

## Endpoint 快查

### UniFi / UCG

- `GET /api/hardware`
- `GET /api/clients`
- `GET /api/network/switches`
- `GET /api/wifi-networks`
- `PUT /api/wifi-networks/:id`
- `GET /api/threats`
- `GET/POST /api/security/threat-blocks`、`DELETE /api/security/threat-blocks/:id`（admin only；公網 IPv4、強制到期、SQLite desired state/audit、UniFi 專用 traffic list reconciliation）
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

### Notifications / Settings / Reports

- `GET/POST /api/notifications/settings`
- `POST /api/notifications/test`
- `GET /api/notifications/log`
- `GET /api/web-push/config`、`POST/DELETE /api/web-push/subscriptions`：public VAPID metadata、admin-only persistent browser subscription lifecycle；private key 永不回傳
- `GET/POST /api/settings`
- `GET/POST /api/connections`
- `GET /api/config/backup`, `GET /api/config/backup/status`, `POST /api/config/restore`（admin only；restore 使用專用 media type 並於 restart 套用）
- `POST /api/reports/run`
- `GET /api/reports/log`（SQLite-persisted report generation and delivery log）

### WiiM / UPS / AdGuard / Linux

- `GET /api/wiim/status`
- `GET /api/wiim/cmd`（只保留 typed read compatibility；mutation 使用受保護的 POST route）
- `GET /api/wiim/art`
- `GET /api/ups/status`
- `GET /api/ups/history`
- `GET /api/ups/events`
- `GET /api/adguard/overview`
- `GET /api/adguard/querylog`、`POST /api/adguard/protection`：共用 `server/integrations/adguard-client.js`；HTTPS 預設驗證、遠端 HTTP 必須明確 opt-in、禁止 redirect/proxy credential forwarding
- `GET/POST /api/adguard/service-policies`、`DELETE /api/adguard/service-policies/:id`：admin-only 每裝置服務封鎖 desired state、baseline restore、SQLite audit 與 bounded reconciliation
- `GET /api/linux/stats`
- `GET /api/linux/history`

### Health / Diagnostics

- `GET /health` / `/healthz` / `/health/ready`
- `GET /api/system/status`
- modules: `observability/logger.js`, `system-monitor.js`, `issue-tracker.js`, `task-tracker.js`, `health-routes.js`

### Recovery service

- `server/services/config-backup.js`: secret-safe export、artifact/hash/schema validation、staged restore、startup rollback transaction
- `db.js#createHistoryDb().backup()`: flush pending telemetry then create a consistent SQLite backup snapshot

### Threat IP blocking

- `server/policies/threat-ip-policy.js`: 公網 IPv4／管理位址／到期／二次確認契約
- `server/integrations/unifi-traffic-list-client.js`: 官方 Network Integration API traffic-list identity 與完整 PUT
- `server/services/threat-ip-blocking.js`: 序列化 mutation/reconciliation、持久 retry backoff、到期移除
- `db.js`: `threat_ip_blocks` desired state 與 bounded `threat_ip_block_audit`

### Frontend runtime trust boundary

- `server/routes/frontend-asset-routes.js`: 只公開 lockfile 鎖定、帶版本 URL 的 Chart/D3/TopoJSON/world-atlas 檔案，並集中設定 CSP/anti-framing/referrer headers
- `server/services/wifi-qr.js`: 同源 Guest WiFi QR SVG；不把 SSID/密碼送往第三方
- `POST /api/wifi/qr`: admin only、Origin/CSRF、嚴格 SSID/WPA 驗證、`no-store`

### AdGuard transport boundary

- `server/integrations/adguard-client.js`: bounded origin/credential/CA/timeout policy，固定 `/control/*` request surface，Basic Auth 只送往已驗證的 configured origin
- `/api/connections`: 寫入任何 `ADGUARD_*` 欄位前先組合候選設定並 fail closed；`ADGUARD_URL` 優先，舊 `ADGUARD_HOST/PORT` 僅保留相容性

### AdGuard per-device service policy

- `server/policies/adguard-service-policy.js`: IP/MAC、YouTube/TikTok/Gaming controlled definitions、IANA timezone 與每日 allow-window 契約；allow window 是 AdGuard blocked-service filtering 的 inactivity period
- `server/services/adguard-service-policy.js`: 序列化 per-device reconciliation、支援 upstream client/catalog 兩種回應形狀、保留非管理欄位、首次 baseline capture、移除還原、bounded retry/drift repair
- `db.js`: `adguard_service_policies` desired state / retry / baseline 與 bounded `adguard_service_policy_audit`

### Web Push

- `server/routes/web-push-routes.js`: production/mock 共用 exact GET/POST/DELETE contract、輸入 policy 與 admin middleware slot；runtime-specific service/error adapter 由組裝入口注入
- `server/policies/web-push-policy.js`: exact HTTPS subscription、P-256/auth key、matched VAPID tuple 與 same-origin visible payload contract
- `server/services/web-push.js`: SQLite subscriptions、24-hour delivery claims、bounded concurrency/retry/backoff、404/410 cleanup；endpoint 只以 hash 寫入 log
- `server/services/pwa-service-worker.js`: production/mock 共用 shell cache、visible push 與 same-origin notification-click renderer
- `server/integrations/notification-delivery.js`: Web Push 是額外 fan-out；primary partial-delivery ambiguity 不可被 fallback 覆寫
- `db.js`: `web_push_subscriptions` 與 bounded `web_push_delivery_claims`

### Long-lived notification/failure state

- `server/services/auto-defense-block-state.js`: Auto Defense 成功 block 的 10-minute propagation cooldown；canonical MAC、future-alarm rejection、2,000-entry recency bound，expiry 後允許新事件重新隔離
- `server/services/docker-notification-state.js`: Docker CPU/RAM cooldown 的單一 owner；container removal cleanup + 2,000-entry recency bound
- `server/services/recoverable-failure-state.js`: integration failure log cooldown 的單一 owner；保留 first-log/cooldown 語意，支援動態 Docker key removal + 2,000-key bound

### Mutable configuration durability

- `server/storage/json-file-store.js`: app、UI preference、client alias、security、notification JSON 的 bounded plain-object reader 與同目錄 0600 temp + fsync + atomic rename writer；API 先落盤再發布 live state
- `server/storage/instance-lock.js`: DATA_DIR 的 transactional SQLite leased owner；hashed runtime/container identity + PID/token、IMMEDIATE claim/reclaim、2 秒 heartbeat/8 秒 lease、legacy PID migration、exact-owner release，失去 owner 時 fail-safe shutdown

## 搜尋範例

```bash
rg -n "app\\.(get|post|put).*ups|readUpsLive|sampleUps" server.js
```
