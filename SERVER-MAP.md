# SmartHub 後端地圖

`server.js` 是組裝入口；可測試邊界在 `server/`，SQLite 在 `db.js`，診斷在 `observability/`。先用本檔找 owner，再精準讀 source。

## 主要負責模組

| 區域 | 搜尋錨點／檔案 |
|---|---|
| 面板安全 | `server/middleware/panel-security.js`、`server/routes/panel-auth-routes.js` |
| 公開登入快照 | `server/services/public-system-health.js` |
| UniFi 本地／雲端 | `unifiLogin`、`server/integrations/site-manager-client.js` |
| UCG／Linux SSH | `server/integrations/ssh-command-stream.js`；UniFi Device thermal 另由 `server/integrations/unifi-device-thermal-ssh.js`（allowlist-only、拒絕不安全 IPv4/IPv6、可選嚴格 Host Key、IP/port/user/key/generation 變更即重建 pool） |
| SQLite／設定 | `DATA_DIR`, `historyDb`, `db.js`, `server/storage/` |
| 報表與排程 | `server/jobs/report-*`, `runSerialJob()` |
| NAS Monitor | `server/integrations/nas-monitor-client.js` |
| WiiM | `server/policies/wiim-command-policy.js`、`server/routes/wiim-command-routes.js` |
| UPS | `readUpsLive`, `createUpsState`, `ups-power-quality.js`, `syncPpbEvents` |
| AdGuard | `server/integrations/adguard-client.js`、policy／service |
| 威脅 IP 封鎖 | `server/policies/threat-ip-policy.js`、`server/services/threat-ip-blocking.js` |
| Web Push | `server/routes/web-push-routes.js`、`server/services/web-push.js` |
| PWA／同源資產 | `server/services/pwa-service-worker.js`、`server/routes/frontend-asset-routes.js` |
| 健康與診斷 | `observability/health-routes.js` |
| 啟停生命週期 | `startServer`, `shutdown`, `server/storage/instance-lock.js` |

## 路由快查

| 類別 | 主要路徑 |
|---|---|
| UCG／UniFi | `/api/hardware`, `/api/clients`, `/api/network/switches`, `/api/wifi-networks`, `/api/threats`, `/api/speedtest*` |
| 威脅封鎖 | `GET/POST /api/security/threat-blocks`, `DELETE /api/security/threat-blocks/:id` |
| 雲端 | `/api/cloud/sites`, `/devices`, `/isp-metrics`, `/hosts`, `/sdwan` |
| NAS | `/api/nas/overview`, `/disks`, `/logs`, `/volumes`, `/ups`, 各歷史路徑 |
| Docker | `/api/nas/docker`, `/api/nas/docker/:id/:action`, `/api/nas/docker/:id/logs` |
| 通知／報表 | `/api/notifications/*`, `/api/reports/run`, `/api/reports/log` |
| Web Push | `/api/web-push/config`, `/api/web-push/subscriptions` |
| 設定／復原 | `/api/settings`, `/api/connections`, `/api/config/backup*`, `/api/config/restore` |
| WiiM | `/api/wiim/status`, `/cmd`, `/art`, `/history`, `/csv` |
| UPS | `/api/ups/status`, `/history`, `/events`, `/ppb-events` |
| AdGuard | `/api/adguard/overview`, `/querylog`, `/protection`, `/service-policies` |
| Linux | `/api/linux/stats`, `/api/linux/history` |
| 活動取樣 | `/api/heartbeat`, `/api/history`, `/api/hardware/history`, `/api/nas/history` |
| 健康 | `/health`, `/healthz`, `/health/ready`, `/api/public/system-health`, `/api/system/status` |

## 重要契約

- 除公開健康與登入資產外，API 受 Session／Basic 相容驗證保護；異動另需 admin、Origin、CSRF 與輸入驗證。
- `/api/public/system-health` 只讀記憶體中的最小摘要，不觸發 SSH、設備 API 或 DB 聚合。
- WiiM `GET /api/wiim/cmd` 只允許讀取；異動使用 POST、高風險命令需精確確認。
- UniFi 威脅封鎖只接受公網 IPv4、強制到期，並只管理專用 `IPV4_ADDRESSES` 清單。
- Docker mutation 與 logs 使用不同 allowlist；SmartHub／broker 容器永久 protected。
- AdGuard 遠端 HTTP 必須明確 opt-in；HTTPS 預設驗證，可使用私有 CA。
- 一般整合失敗不會阻止 readiness；SQLite 或 worker 異常才使 `/health/ready` 回 503。
- 前端可見 endpoint／欄位變更必須同步 `server-mock.js`。

## 長期執行邊界

- `runSerialJob()` 阻止同名工作重入；報表另以 SQLite claim、lease、retry、deadline、fencing 管理。
- `instance-lock` 使用 2 秒 heartbeat／8 秒 lease 保證單一 DATA_DIR owner。
- SSH 命令共用 12 秒期限與 1 MiB stdout／stderr 上限。
- UniFi Device telemetry 的 GET 僅讀取專用 snapshot；Controller 與 allowlist SSH 由 60/300 秒 sampler 刷新。Snapshot stale 會下傳到每台設備且不進通知狀態機；設定變更會作廢舊 queue/inflight 結果，reset 造成的 SSH reject 也分類為 `configuration_changed`。
- 歷史佇列、resource samples、cooldown maps、subscriptions 與 audit 都有容量或 retention。
- UPS 在總覽/UPS 焦點下真實 3 秒取樣，閒置預設 10 秒；PPB 事件同步為焦點 10 秒、閒置 60 秒。

## 搜尋範例

```bash
rg -n "app\\.(get|post|put|delete).*ups|readUpsLive" server.js
rg -n "threat-ip|service-policy|web-push" server test
```
