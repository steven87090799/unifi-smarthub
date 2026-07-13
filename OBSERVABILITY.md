# SmartHub 可觀測性與除錯指南

## Current Architecture Analysis

| 項目 | 目前架構 |
|---|---|
| Backend | Node.js 20、Express 4，正式入口 `server.js` |
| Frontend | 單檔 SPA `public/index.html`，Tailwind CDN、Chart.js、D3 |
| Database | `better-sqlite3` 單連線、WAL；歷史序列與事件集中在 `data/smarthub.db` |
| 設定儲存 | `app-settings.json`、`security-settings.json`、`notification-settings.json`、`.env` |
| Worker / Queue | 同一 Node process 內的週期排程，`runSerialJob()` 防同名工作重入；沒有外部 queue broker |
| Docker | 單一 `unifi-smarthub` service、tini、非 root、具名 volume、256 MB memory limit |
| 外部服務 | UniFi local/cloud、UCG/Linux SSH、UGREEN NAS、NAS Monitor、WiiM、UPS、AdGuard；全部為選配 |

## Problems Found（實作前）

| File / Function | 問題 | 影響 |
|---|---|---|
| `server.js` / `sysLog()` | 只有 info/error 兩級，無 request/task ID、JSON、錯誤碼或 secret masking | Docker log 難以關聯請求與背景工作，也不適合直接匯入 log backend |
| `server.js` / HTTP middleware | 記錄所有 API request 與 query，沒有 duration/response status | 高頻輪詢容易洗版，錯誤 request 仍缺 stack/context |
| `server.js` / `runSerialJob()` | 只有 running `Set` | 無 completed/failed/retry/stuck 統計與 task lifecycle |
| `db.js` | 有 WAL/busy timeout，但無 query latency、slow query、health/pool-style diagnostics | SQLite 是否健康只能等實際 API 失敗才知道 |
| 多個設定寫入函式 | catch 後直接忽略寫檔錯誤 | UI 可能顯示成功，但重啟後設定遺失 |
| 多個 API catch | 直接回傳原始 `error.message`，且部分沒有 stack log | 可能洩漏內部資訊，Docker log 又不足以定位 |
| `/healthz` | 只證明 Express process 活著 | SQLite 或 worker 卡住時 Docker 仍顯示 healthy |
| `public/index.html` | 只有設備連線狀態，沒有 app/DB/worker/resource 狀態 | 不進 terminal 無法快速看 active issue |

## 模組

| File | 用途 |
|---|---|
| `observability/error-codes.js` | 中央狀態碼，其他檔案只引用常數 |
| `observability/logger.js` | DEBUG/INFO/WARNING/ERROR/CRITICAL、console/JSON、AsyncLocalStorage context、secret masking |
| `observability/issue-tracker.js` | active issue 去重、cooldown、occurrence、resolve 與最近解除紀錄 |
| `observability/task-tracker.js` | task ID、created/queued/started/heartbeat/completed/failed 時間與 worker counters |
| `observability/system-monitor.js` | CPU/RAM/disk/SQLite/worker 低頻取樣、threshold、60 筆 ring buffer、stuck detection |
| `observability/health-routes.js` | liveness、readiness、完整 diagnostics API |

## Log 格式

Console（預設）：

```text
2026-07-13 10:35:25 | ERROR | SMARTHUB | database.sqlite | insertPoint | PID=32 | WORKER=main | TASK=8af32 | CODE=DB-QUERY-001 | SQLite operation failed | operation=insertPoint | table=history
```

JSON：

```env
LOG_FORMAT=json
# 或 LOG_JSON=true
```

每筆 record 包含可用的 `request_id`、`trace_id`、`task_id`、`http_status`、`status_code`、error type/message/stack。password、API key、token、Authorization、cookie、session、webhook 與已知環境 secret 會先遮罩。正常 API 與週期工作 START/SUCCESS 是 DEBUG；4xx、5xx、worker failure 與資源告警會依 WARNING/ERROR/CRITICAL 輸出。

## Health API

| Endpoint | Auth | 成本 / 用途 |
|---|---|---|
| `GET /health` | 不需 | 純 process liveness；Docker healthcheck 使用 |
| `GET /healthz` | 不需 | 舊版相容 alias |
| `GET /health/ready` | 不需 | SQLite `SELECT 1` + worker stuck 狀態；異常回 503 |
| `GET /api/system/status` | 沿用 `PANEL_PASSWORD` | 完整 CPU/RAM/disk/SQLite/worker/issues/trend diagnostics |

外部家用設備是選配，不會 gate readiness。設備開機狀態仍由 `/api/connections/status` 與啟動 diagnostics 顯示。

## Status Code List

- SYSTEM：`SYS-START-001`、`SYS-READY-001`、`SYS-SHUTDOWN-001`、`SYS-START-FAILED-001`、`SYS-CONFIG-001`、`SYS-CRASH-001/002`、`SYS-CPU-001/002`、`SYS-MEM-001/002/003`、`SYS-DISK-001/002`、`SYS-RESOURCE-OK-001`、`SYS-MONITOR-001`
- DATABASE：`DB-CONN-001/002/003`、`DB-QUERY-001`、`DB-QUERY-SLOW-001`、`DB-TX-001`、`DB-HEALTH-001`、`DB-MIGRATE-001/002/003`、`DB-CLOSE-001`
- API：`API-REQ-001/002`、`API-AUTH-001`、`API-VALID-001`、`API-NOTFOUND-001`、`API-INTERNAL-001`、`API-HEALTH-001`、`API-READY-001/002`
- WORKER：`WORKER-START-001`、`WORKER-READY-001`、`WORKER-TASK-001/002/003/004`、`WORKER-STUCK-001`
- EXTERNAL：`EXT-UNIFI-001`、`EXT-NAS-001`、`EXT-NASMON-001`、`EXT-WIIM-001`、`EXT-UPS-001`、`EXT-ADGUARD-001`、`EXT-LINUX-001`、`EXT-NOTIFY-001`

權威清單以 `observability/error-codes.js` 為準。

## 維運指令

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f unifi-smarthub

docker compose logs unifi-smarthub | grep 'ERROR'
docker compose logs unifi-smarthub | grep 'CRITICAL'
docker compose logs unifi-smarthub | grep 'DB-CONN-001'
docker compose logs unifi-smarthub | grep 'TASK=8af32'

curl -fsS http://localhost:3000/health
curl -fsS http://localhost:3000/health/ready
curl -fsS -u "admin:${PANEL_PASSWORD}" http://localhost:3000/api/system/status
```

若要用 task ID 追正常 START/SUCCESS lifecycle，將 `LOG_LEVEL=DEBUG` 後重啟。正式環境預設 INFO 避免高頻排程 log spam。

## Known Limitations

- SQLite 是同步、單連線、無 connection pool；API 的 pool 欄位會明確回報 `single_connection`，waiting 永遠為 0。
- 專案沒有外部 queue；`queued_tasks` 固定為 0，重入的同名工作會被 skipped，不會排隊。
- Node 主程序為單 event loop，`worker_id=main`；目前沒有 Worker Threads 可提供 thread ID。
- resource trend 是記憶體內 60 筆 ring buffer，重啟會清空，尚未提供 Prometheus endpoint。
- process CPU 與 host system CPU 都會提供；Docker memory 優先讀 cgroup limit/usage，非容器環境才讀 host memory。
- `Possible memory growth detected` 至少需要 10 個 sample、8 次上升且增幅超過 20 MB 或 20%；它是診斷線索，不等同已證實 memory leak。
