# SmartHub 後端地圖

`server.js` 是組裝入口；可測試邊界在 `server/`，SQLite 在 `db.js`，診斷在 `observability/`。先用本檔找 owner，再精準讀 source。

## 主要負責模組

| 區域 | 搜尋錨點／檔案 |
|---|---|
| 面板安全 | `server/middleware/panel-security.js`、`server/routes/panel-auth-routes.js` |
| 公開登入快照 | `server/services/public-system-health.js` |
| UniFi 本地／雲端 | `unifiLogin`、`server/integrations/site-manager-client.js` |
| UniFi 裝置遙測 | `unifi-device-telemetry*.js`、`server/integrations/unifi-device-thermal-ssh.js` |
| UCG／Linux SSH | `server/integrations/ssh-command-stream.js`、`ssh-connection-pool.js` |
| SQLite／設定 | `DATA_DIR`, `historyDb`, `db.js`, `server/storage/` |
| 報表與排程 | `server/jobs/report-*`, `runSerialJob()` |
| NAS Monitor | `server/integrations/nas-monitor-client.js` |
| WiiM | `server/policies/wiim-command-policy.js`、`server/routes/wiim-command-routes.js`、`server/services/wiim-art-proxy.js`、`server/services/wiim-config.js` |
| UPS | `readUpsLive`, `createUpsState`, `ups-power-quality.js`, `server/integrations/ppb-client.js`, `server/services/ppb-event-sync.js` |
| AdGuard | `server/integrations/adguard-client.js`、policy／service |
| 威脅 IP 封鎖 | `server/policies/threat-ip-policy.js`、`server/services/threat-ip-blocking.js` |
| Web Push | `server/routes/web-push-routes.js`、`server/services/web-push.js` |
| PWA／同源資產 | `server/services/pwa-service-worker.js`、`server/routes/frontend-asset-routes.js` |
| 健康與診斷 | `observability/health-routes.js` |
| Scope 取樣 | `activity-lease.js`、`server/services/backend-sampler-registry.js`、`adaptive-sampler.js` |
| 啟停生命週期 | `startServer`, `shutdown`, `server/storage/instance-lock.js` |

## 路由快查

| 類別 | 主要路徑 |
|---|---|
| UCG／UniFi | `/api/hardware`, `/api/clients`, `/api/network/switches`, `/api/network/devices/telemetry`, `/api/network/devices/telemetry/history`, `/api/wifi-networks`, `/api/threats`, `/api/speedtest*` |
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
- UniFi 裝置遙測 GET 只讀專用記憶體快照／SQLite history；只有 `unifiDeviceTelemetry` sampler 可查 Controller、開 Device SSH、寫 history。失敗保留最後成功值並標示 stale，stale／offline 溫度不入庫也不推進通知狀態。
- Device SSH 由 MAC allowlist（最多 32 台）與 Controller 已知設備雙重限制，只接受安全 Literal IP、固定 thermal command、12 秒 deadline 與 128 KiB output cap；每台可釘選 SHA256 Host Key，最多同時兩個工作。
- WiiM `GET /api/wiim/cmd` 只允許讀取；異動使用 POST、高風險命令需精確確認。
- WiiM `WIIM_IP` 為選配且只接受 literal IPv4/IPv6；留空時 status/history/command/art/sampler/watcher 都不觸發裝置讀取，封面代理只允許明確設定的 literal 私有位址，並有 DNS pin、TLS/HTTP opt-in、redirect/MIME/大小與 bounded LRU 限制。
- UniFi Network API 預設嚴格 TLS 驗證；`UNIFI_NETWORK_CA_FILE` 可指定絕對私有 CA，停用驗證與 HTTP 都必須分別明確 opt-in。
- UniFi 威脅封鎖只接受公網 IPv4、強制到期，並只管理專用 `IPV4_ADDRESSES` 清單。
- Docker mutation 與 logs 使用不同 allowlist；SmartHub／broker 容器永久 protected。
- AdGuard 遠端 HTTP 必須明確 opt-in；HTTPS 預設驗證，可使用私有 CA。
- PPB HTTPS 預設驗證；私有 CA 只接受有界的絕對一般檔案，停用驗證必須明確設定 `PPB_TLS_INSECURE=true`。
- PPB 首次成功同步只建立 source-specific 初始化狀態，不通知歷史事件；失敗不會誤標初始化。
- 一般整合失敗不會阻止 readiness；SQLite 或 worker 異常才使 `/health/ready` 回 503。
- 前端可見 endpoint／欄位變更必須同步 `server-mock.js`。

## 長期執行邊界

- `runSerialJob()` 阻止同名工作重入；報表另以 SQLite claim、lease、retry、deadline、fencing 管理。
- Scope registry 只重排匹配 `trend`／`ucg`／`unifi-device-telemetry`／`nas`／`wiim`／`ups`／`linux` 的 sampler；`general` 不會加速設備取樣，設定變更才全量重排。
- 活動 lease 以分頁 session 隔離，最多 1,000 sessions、每 session 8 scopes，過期優先清理後才以 LRU 淘汰；診斷不回傳 session ID。
- `instance-lock` 使用 2 秒 heartbeat／8 秒 lease 保證單一 DATA_DIR owner。
- 一般 SSH 命令共用 12 秒期限與 1 MiB stdout／stderr 上限；Device thermal 使用更小的 128 KiB 上限。Pool shutdown 會拒絕 pending／queued command，late ready 不得復活連線；Host Key 設定輪替會使候選連線失效。
- 歷史佇列、resource samples、cooldown maps、subscriptions 與 audit 都有容量或 retention。
- UPS 在總覽/UPS 焦點下真實 3 秒取樣，閒置預設 10 秒；PPB 事件同步為焦點 10 秒、閒置 60 秒。

## 搜尋範例

```bash
rg -n "app\\.(get|post|put|delete).*ups|readUpsLive" server.js
rg -n "threat-ip|service-policy|web-push" server test
```
