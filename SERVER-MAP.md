# SmartHub Backend Map

`server.js` 是正式後端組裝入口；可觀測性拆在 `observability/*.js`，SQLite wrapper 在 `db.js`，可測試的整合／middleware／policy／job／service 邊界在 `server/`。後端任務先用這份索引定位 symbol，再讀小區段；行號只作搜尋提示，不是契約。

## 主要區段

| 行號約略 | 區段 | 內容 |
|---:|---|---|
| 1-100 | 啟動與共用工具 | structured logger、error code、request context、Basic Auth、`apiError()` |
| 100-175 | UniFi client | 本地控制器 login/cookie、Cloud client |
| 180-345 | UCG hardware | SSH 取 CPU/記憶體/磁碟/網路，`/api/hardware` |
| 350-497 | UniFi Network | clients、switches、WiFi、threats |
| `DATA_DIR`, `historyDb` | Data / DB / settings | SQLite、SystemMonitor、app settings、啟動時 staged restore |
| 625-730 | Client controls | alias、block/unblock、PoE、speedtest |
| 740-790 | Site Manager | cloud sites/devices/isp/hosts/sdwan |
| 790-888 | Security | security settings、auto defense |
| 890-1230 | Notifications / scheduler | settings、dispatch、watcher、task trace、server jobs |
| 1231-1300 | Trend history | adaptive sampling、history、heartbeat |
| 1302-1685 | UGOS NAS | NAS auth/token、overview、disks、logs、UPS |
| 1687-1752 | UCG/NAS history | hardware and NAS historical samples |
| 1753-1974 | NAS Monitor | docker、traffic、alerts、SSE stream |
| `CONN_FIELDS`, `configBackupService` | Settings/connections/recovery | `/api/settings`、`.env` persistence、backup/restore、client rebuild |
| 2075-2316 | Reports/PWA | report builder/scheduler、manifest、service worker |
| 2317-2497 | WiiM | LinkPlay proxy、status、history、art、CSV |
| 2498-2778 | UPS | PPB/NUT/pwrstat/pmset、status/history/events/CSV |
| 2779-2824 | AdGuard | overview、querylog、protection |
| 2825-2920 | Linux host | SSH stats、history |
| 2920-2977 | Health/status | device status、critical alerts、health/readiness/system status |
| 2978-3143 | Startup / errors | external diagnostics、API error handler、listen、shutdown/crash handlers |

## Endpoint 快查

### UniFi / UCG

- `GET /api/hardware` around 347
- `GET /api/clients` around 363
- `GET /api/network/switches` around 390
- `GET /api/wifi-networks` around 430
- `PUT /api/wifi-networks/:id` around 443
- `GET /api/threats` around 458
- `PUT /api/device/restrict` around 642
- `POST /api/poe/power-cycle` around 676
- `POST /api/speedtest` around 693
- `GET /api/speedtest/status` around 708
- `GET /api/hardware/history` around 1679

### Cloud Site Manager

- `GET /api/cloud/sites` around 726
- `GET /api/cloud/devices` around 739
- `GET /api/cloud/isp-metrics` around 752
- `GET /api/cloud/hosts` around 784
- `GET /api/cloud/sdwan` around 797

### NAS / NAS Monitor

- `GET /api/nas/overview` around 1416
- `GET /api/nas/disks` around 1493
- `GET /api/nas/disk-smart` around 1515
- `GET /api/nas/logs` around 1540
- `GET /api/nas/sleep-stats` around 1565
- `GET /api/nas/volumes` around 1627
- `GET /api/nas/ups` around 1647
- `GET /api/nas/docker` around 1787
- `POST /api/nas/docker/:id/:action` around 1798
- `GET /api/nas/docker/:id/logs` around 1815
- `GET /api/nas/alerts` around 1881
- `GET /api/nas/stream` around 1964

### Notifications / Settings / Reports

- `GET/POST /api/notifications/settings` around 999/1018
- `POST /api/notifications/test` around 1037
- `GET /api/notifications/log` around 1043
- `GET/POST /api/settings` around 1976/1977
- `GET/POST /api/connections` around 2036/2047
- `GET /api/config/backup`, `GET /api/config/backup/status`, `POST /api/config/restore`（admin only；restore 使用專用 media type 並於 restart 套用）
- `POST /api/reports/run` around 2640
- `GET /api/reports/log` around 2644 (SQLite-persisted report generation and delivery log)

### WiiM / UPS / AdGuard / Linux

- `GET /api/wiim/status` around 2405
- `GET /api/wiim/cmd` around 2435
- `GET /api/wiim/art` around 2447
- `GET /api/ups/status` around 2755
- `GET /api/ups/history` around 2763
- `GET /api/ups/events` around 2769
- `GET /api/adguard/overview` around 2789
- `GET /api/linux/stats` around 2889
- `GET /api/linux/history` around 2910

### Health / Diagnostics

- `GET /health` / `/healthz` / `/health/ready` registered around 2976
- `GET /api/system/status` registered around 2976
- modules: `observability/logger.js`, `system-monitor.js`, `issue-tracker.js`, `task-tracker.js`, `health-routes.js`

### Recovery service

- `server/services/config-backup.js`: secret-safe export、artifact/hash/schema validation、staged restore、startup rollback transaction
- `db.js#createHistoryDb().backup()`: flush pending telemetry then create a consistent SQLite backup snapshot

## 搜尋範例

```bash
rg -n "app\\.(get|post|put).*ups|readUpsLive|sampleUps" server.js
sed -n '2498,2778p' server.js
```
