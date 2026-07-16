# SmartHub 可觀測性與除錯

## 架構

| 區域 | 實作 |
|---|---|
| Log | `observability/logger.js`：等級、JSON／console、request／task context、機密遮罩 |
| Issue | `issue-tracker.js`：去重、冷卻、次數與解除紀錄 |
| Task | `task-tracker.js`：開始、heartbeat、完成、失敗與 stuck |
| Resource | `system-monitor.js`：CPU、RAM、disk、SQLite、worker，保留 60 筆 |
| Health | `health-routes.js`：liveness、readiness、完整 diagnostics |
| Database | `better-sqlite3` 單連線、WAL、query latency 與 quick health |

## 日誌

預設 console；需要 log backend 時：

```env
LOG_FORMAT=json
LOG_LEVEL=WARNING
DEBUG_HTTP=1
```

正常 request／週期工作成功訊息在 DEBUG；4xx、5xx、worker 與資源異常依 WARNING／ERROR／CRITICAL 輸出。Authorization、cookie、session、password、token、API key、CSRF 與 webhook 會遮罩。

## 健康端點

| 路徑 | 驗證 | 用途 |
|---|---|---|
| `/health` | 無 | 程序存活與 build identity |
| `/healthz` | 無 | 舊版相容 |
| `/health/ready` | 無 | SQLite `SELECT 1` 與 worker stuck；異常回 503 |
| `/api/public/system-health` | 無 | 登入頁最小記憶體快照，不探測設備 |
| `/api/system/status` | 需要 | CPU、RAM、disk、SQLite、worker、issues、trend |

外部設備都是選配，不 gate readiness。

## 報表交付

- 每個排程時段使用唯一 `schedule_key` 與 SQLite transaction claim。
- owner token、lease renewal、deadline 與 fencing 防止並行重複完成。
- 一般失敗 60 秒後重試，最多 3 次；stale claim 與重啟由 recovery scan 接續。
- 語意是 at-least-once attempt。外部已接受但 completion 尚未落盤時，重啟後可能再送；Webhook 以穩定 `Idempotency-Key` 去重。
- 部分訊息已送達時記錄為 terminal `partial`，不自動重送。

## 有界狀態

- 一般歷史佇列上限 1,000 筆或 1 MiB，SQLite retention 由設定控制。
- resource samples 60 筆；report identities、claims、subscriptions、cooldown maps 與 audits 均有限制或 retention。
- 可變 JSON 設定上限 1 MiB，使用 `0600` 暫存、fsync 與 atomic rename。
- DATA_DIR 使用 SQLite 租約鎖；2 秒 heartbeat、8 秒 lease，失去 owner 時安全關閉。
- UCG／Linux SSH 命令有 12 秒期限與 1 MiB輸出上限。

## 狀態碼分類

- `SYS-*`：程序、設定、資源與生命週期
- `DB-*`：連線、查詢、交易、migration、health
- `API-*`：驗證、輸入、找不到、內部錯誤、health
- `WORKER-*`：工作開始、完成、失敗、stuck
- `EXT-*`：UniFi、NAS、WiiM、UPS、AdGuard、Linux、通知

權威清單：`observability/error-codes.js`。

## 常用指令

```bash
docker compose --env-file config/.env ps
docker compose --env-file config/.env logs -f unifi-smarthub
docker compose --env-file config/.env logs unifi-smarthub | grep 'ERROR\\|CRITICAL'
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/health/ready
curl --user admin http://127.0.0.1:3000/api/system/status
```

追正常 task lifecycle 時暫設 `LOG_LEVEL=DEBUG`；完成後改回 WARNING／INFO，避免高頻 log。

## 已知限制

- SQLite 為同步單連線，沒有外部 pool。
- 主程序為單一 event loop，沒有 Worker Threads 或外部 queue。
- resource trend 在記憶體內，重啟會清空；沒有內建 Prometheus。
- 短時間 accelerated endurance 只證明已執行 cycles，不代表 365 天無故障。
- 長期 RSS、restart、volume growth 與 log retention 應由部署層監控。
