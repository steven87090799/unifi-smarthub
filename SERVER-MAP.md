# SmartHub Backend Map

`server.js` 是正式後端，約 2950 行。後端任務先用這份索引定位，再讀小區段。

## 主要區段

| 行號約略 | 區段 | 內容 |
|---:|---|---|
| 1-54 | 啟動與共用工具 | dotenv、Express、Basic Auth、HTTP log、`sysLog()` |
| 55-126 | UniFi client | 本地控制器 login/cookie、Cloud client |
| 129-298 | UCG hardware | SSH 取 CPU/記憶體/磁碟/網路，`/api/hardware` |
| 311-451 | UniFi Network | clients、switches、WiFi、threats |
| 451-543 | Data dir / flush | `DATA_DIR`、history flush、app settings |
| 546-648 | Client controls | alias、block/unblock、PoE、speedtest |
| 666-737 | Site Manager | cloud sites/devices/isp/hosts/sdwan |
| 752-817 | Security | security settings、auto defense |
| 826-1129 | Notifications | settings、dispatch、watcher、server jobs |
| 1139-1205 | Trend history | adaptive sampling、history、heartbeat |
| 1213-1562 | UGOS NAS | NAS auth/token、overview、disks、logs、UPS |
| 1575-1657 | UCG/NAS history | hardware and NAS historical samples |
| 1664-1862 | NAS Monitor | docker、traffic、alerts、SSE stream |
| 1872-1940 | Settings/connections | `/api/settings`, `.env` persistence, rebuild clients |
| 1960-2177 | Reports/PWA | report builder/scheduler、manifest、service worker |
| 2209-2378 | WiiM | LinkPlay proxy、status、history、art、CSV |
| 2397-2666 | UPS | PPB/NUT/pwrstat/pmset、status/history/events/CSV |
| 2676-2710 | AdGuard | overview、querylog、protection |
| 2720-2805 | Linux host | SSH stats、history |
| 2814-2870 | Health/status | cloud status、critical alerts、healthz |
| 2875-2950 | Startup | connection hints、diagnostics、listen |

## Endpoint 快查

### UniFi / UCG

- `GET /api/hardware` around 298
- `GET /api/clients` around 311
- `GET /api/network/switches` around 339
- `GET /api/wifi-networks` around 379
- `PUT /api/wifi-networks/:id` around 393
- `GET /api/threats` around 409
- `PUT /api/device/restrict` around 580
- `POST /api/poe/power-cycle` around 614
- `POST /api/speedtest` around 632
- `GET /api/speedtest/status` around 648
- `GET /api/hardware/history` around 1586

### Cloud Site Manager

- `GET /api/cloud/sites` around 666
- `GET /api/cloud/devices` around 679
- `GET /api/cloud/isp-metrics` around 692
- `GET /api/cloud/hosts` around 724
- `GET /api/cloud/sdwan` around 737

### NAS / NAS Monitor

- `GET /api/nas/overview` around 1324
- `GET /api/nas/disks` around 1401
- `GET /api/nas/disk-smart` around 1423
- `GET /api/nas/logs` around 1444
- `GET /api/nas/sleep-stats` around 1469
- `GET /api/nas/volumes` around 1531
- `GET /api/nas/ups` around 1551
- `GET /api/nas/docker` around 1695
- `POST /api/nas/docker/:id/:action` around 1706
- `GET /api/nas/docker/:id/logs` around 1719
- `GET /api/nas/alerts` around 1785
- `GET /api/nas/stream` around 1862

### Notifications / Settings / Reports

- `GET/POST /api/notifications/settings` around 916/935
- `POST /api/notifications/test` around 953
- `GET /api/notifications/log` around 959
- `GET/POST /api/settings` around 1872/1873
- `GET/POST /api/connections` around 1929/1940
- `POST /api/reports/run` around 2177

### WiiM / UPS / AdGuard / Linux

- `GET /api/wiim/status` around 2298
- `GET /api/wiim/cmd` around 2328
- `GET /api/wiim/art` around 2338
- `GET /api/ups/status` around 2650
- `GET /api/ups/history` around 2658
- `GET /api/ups/events` around 2664
- `GET /api/adguard/overview` around 2684
- `GET /api/linux/stats` around 2782
- `GET /api/linux/history` around 2805

## 搜尋範例

```bash
rg -n "app\\.(get|post|put).*ups|readUpsLive|sampleUps" server.js
sed -n '2397,2668p' server.js
```
