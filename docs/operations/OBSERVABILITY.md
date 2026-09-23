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

`/health/operational` 需登入，讀取既有取樣結果。設備新鮮度依取樣間隔保留三個週期（至少 180 秒），避免閒置 600 秒取樣被固定 180 秒門檻誤報；明確連續失敗仍回報 degraded／critical。WiiM 使用請求健康紀錄，不以兩秒 response cache 判定連線。Controller 與 NAS Monitor 分別依設備清單、Docker 清單的取樣結果判讀，token 存在不是成功證據。通知項目僅代表持久化報表交付結果，無紀錄仍是 unknown，不代表已測試 Telegram；事件交付不因三分鐘沒有新報表而過期。

UniFi 威脅事件優先使用 legacy alarm；僅在 endpoint 不存在或 InvalidObject 時改查 v2 system-log/threat-alert。認證、網路錯誤及不完整分頁仍回報失敗，不用空陣列掩蓋。

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


### 監控介面與通知驗收（2026-09-23）

- 通知頁首次 hydration 必須讀取通知設定；載入失敗不得用空白表單覆寫。Token 留空代表沿用，`botTokenSet` 才是是否存在的依據；不應盲目勾選所有告警。
- WiiM 2 秒 API cache freshness 不代表設備離線。連線通知依真實取樣成功／連續失敗判斷；只有兩次實際失敗才轉離線，單次錯誤、尚未取樣或取樣逾期維持 unknown，不製造離線／恢復事件。排程停止仍由 operational health 的 stale 檢查呈現。
- IPv4 與 IPv6 位址各自比較 DHCP 變化，避免 Controller 交替回報兩種位址而產生假 IP 變更通知。
- 通知 transport health 合併實際推播結果及持久化報表結果；跳過、partial 或 Web Push fallback 不代表主要 Telegram 管道投遞成功。Telegram 網路例外保留有限的錯誤碼，避免僅顯示 delivery failed；不自動重送結果不明的訊息。
- 部分 WiiM AirPlay JPEG 不提供 Content-Type。只有精確設定的 WiiM literal 位址可在缺少標頭時，以 JPEG／PNG signature 辨識；公開 CDN、redirect、大小與非圖片限制仍保留。
- UPS 短歷史使用整數 `minutes=10`／`minutes=30`；hours 仍維持原本嚴格整數驗證。錯誤回應不可解讀為「沒有資料」。UPS 預設焦點 3 秒、背景 10 秒持續取樣，前端歷史每 10 秒刷新。此取樣不能保證捕捉兩次讀值之間的瞬間事件；需配合 PPB 事件紀錄。
- AP 曲線按 deviceId 分開，以實際 history 資料繪製；Device SSH 溫度代表所有 thermal zones 最高值，並顯示各區域值。不能用 AP 晶片溫度直接當成 UCG CPU 溫度比較。
- UCG telemetry 可沿用既有 UCG SSH sampler，限定 Controller host 與 UCG_IP 相符且只有一台 gateway；不新增 SSH 登入。保留原始取樣時間和 ucg_ssh 來源。
- Radio 狀態合併 `radio_table_stats` 與設定表；不支援的溫度、空 radio/VAP 與未知欄位不顯示成虛構數值。
