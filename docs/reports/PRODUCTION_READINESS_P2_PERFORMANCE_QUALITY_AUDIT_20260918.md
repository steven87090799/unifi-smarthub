# SmartHub P2 效能、資源與工程品質稽核 — 2026-09-18

## Executive Summary

本次從獨立的最新 `origin/main` 基底開始，確認並修復 **3 項 P2、1 項 P3**，沒有合併其他 P0/P1 分支。修復範圍是 SQLite 清理候選查詢、Service Worker 快取與生命週期，以及前端頁面計時器／已排程回呼。沒有改 public API、DB schema、依賴版本、正式設定或容器上限。

基底在乾淨依賴環境及非 root 使用者下 **755/755 PASS**；最終修復樹 **798/798 PASS**。新增的 43 個測試包含實際 SQL 執行計畫、結果一致性、生成的 Service Worker 行為、14 頁輪詢矩陣，以及 UPS sampling deadline／隔離 runtime fixture 回歸。先在基底確認 regression 會失敗，再驗證修復後通過。正式 server 的隔離 smoke 與 **90.059 秒**短 soak 均通過。這不等於正式設備驗收、完整真實瀏覽器驗收，或 24/72 小時耐久驗證。

365 天「合成資料量」的遙測候選查詢中位數 **48.203 → 0.046 ms**；30 天合成資料完整清理 **549.054 → 307.373 ms**。這些是特定查詢／fixture 的實測，不能推導整個網站快一千倍，也不能稱為真實運作 365 天。

## Repository / Base / Final SHA

| 項目 | 紀錄 |
|---|---|
| Repository | `steven87090799/unifi-smarthub` |
| Base SHA | `5db2b72d86ada93f46297e4d974f7dcedb93dcaa` |
| Base tree | `170a306e73c049ffb9cb249b108420ce9fe8867b` |
| Branch | `codex/p2-performance-quality-audit-20260918` |
| 日期 | 2026-09-18，Asia/Taipei |
| Node / npm / SQLite | `24.18.0` / `11.16.0` / `3.53.2` |
| 平台 | Linux x64，AMD EPYC 9V74，環境可見 5 個 logical CPUs |
| Working tree | 獨立目錄；基底 Git tree 雜湊一致；沒有他人變更 |
| Docker / Compose | 本機無可用執行檔；Hosted CI 的 exact-head 結果另列於 PR |
| Final SHA | 以本 PR 最後一個 commit 與 PR body 的 exact HEAD 紀錄為準；同一 commit 不能在自身內容嵌入自己的 SHA |

本機 GitHub DNS 無法解析，沒有將 clone/fetch 失敗寫成成功。已用 GitHub connector 讀取最新 main，經一次性、唯讀 source-transfer workflow 取得 tracked archive、commit object、Node 24 與實際 `npm ci` 安裝結果。下載後驗證 archive checksums、base commit 與 tree；原始基底另建 detached worktree。提交使用隔離分支的正常 fast-forward push，臨時 transfer/apply 檔案不留在最終 PR diff。

原始測試及量測記錄另以本次交付的 evidence ZIP 保存；其關鍵檔案 SHA256 與量測摘要在 [evidence/p2-20260918.json](evidence/p2-20260918.json)。實際 latest HEAD、PR number、Actions run URL、job conclusion 以 PR body 與交付總結為權威，不把歷史綠燈當本次驗證。

## Architecture Inventory

審查以實際 owner、呼叫邊界、錯誤／生命週期與對應測試為主，不是只讀 README，也不是宣稱每一行已經得到形式驗證。

| Module | Files / Entry Points | Dependencies / 互動 | Tests | Status |
|---|---|---|---|---|
| 啟動／關機 | `server.js`、`server-mock.js`、`startServer`／shutdown | config → DB/lock → services/jobs → HTTP；關機停止新工作再釋放資源 | server-lifecycle、runtime smoke/soak | REVIEWED；隔離 restart PASS |
| 驗證／輸入 | `server/middleware/panel-security.js`、panel-auth routes、write/query policies | public login → authentication → role／Origin／CSRF → bounded parser → route | panel-security、panel-login、write-route-contract、express5 | REVIEWED；邊界 smoke PASS |
| 頁面／hydration | `public/index.html`、`app.js`、`frontend-lifecycle.js` | 14 頁 → hydration coordinator → page/common polling → same-origin API | frontend-lifecycle、lazy-hydration、新 polling matrix | REVIEWED；P2-003 FIXED |
| 靜態資產／PWA | bootstrap、action-dispatcher、frontend-asset routes、pwa-service-worker | same-origin script、CSP、build cache、login fallback；production/mock 共用 renderer | CSP/runtime-assets、panel-login、新 PWA 行為測試 | REVIEWED；P2-002/P3-001 FIXED |
| Chart／鏡像／SSE | app.js 的 chart/downsample、pinned mirror、NAS EventSource | Chart instance 更新、observer scope、visibility、SSE backpressure | frontend overview/telemetry/WiiM、SSE、短 soak | 邊界 REVIEWED；真瀏覽器 BLOCKED |
| SQLite | `db.js`、buffer／rollup／cleanup／backup／diagnostics | sampler → bounded buffer → transaction → raw/rollups → history API | history-buffer/downsampling、telemetry-db、新 candidate tests | REVIEWED；P2-001 FIXED |
| Scope／取樣／快取 | activity-lease、adaptive-sampler、backend-sampler-registry、device-collector-cache、sample-deduper | per-tab lease → 匹配 sampler；shared in-flight/cache → snapshot | 同名 unit/integration、upstream fixture | REVIEWED；不改現有上游取樣語意 |
| UniFi／SSH／Cloud | server.js UniFi owners、site-manager、unifi-auth-retry、SSH pool/stream/thermal、telemetry snapshot | Controller auth、typed transport/TLS、bounded SSH、snapshot/history/alerts | UniFi／SSH／Site Manager／TLS tests | 重要邊界 REVIEWED；實機 NOT RUN |
| NAS／Docker broker | NAS login/token/retry、nas-monitor-client、`nas-monitor/server.js`、docker policies/snapshots | singleflight、token fencing、bounded retry、semaphore、allowlist、SSE | nas-monitor、NAS retry、docker-log/action、SSE | REVIEWED；假 socket PASS，實際 socket NOT RUN |
| UPS／PPB | ups-state/source-selection/observability、ppb-event-sync、ppb-client | background sample → state/snapshot → DB/events → notification；GET 不寫入 | UPS runtime/read-only/state/deadline、PPB tests | REVIEWED；P2-004 FIXED；真實 PPB/UPS NOT RUN |
| WiiM／AdGuard／防禦 | wiim-client/art/config/command、AdGuard client/service/policy、threat-ip-blocking | typed stale/cache、明確 mutation confirmation、allowlist／到期 reconcile | WiiM、AdGuard、threat policy/service/route | 邊界 REVIEWED；無實機異動 |
| 報表／通知 | report-runner/schedule、notification-delivery、web-push | DB claim/lease/fencing → bounded delivery；partial terminal；Web Push fan-out | report-runner/schedule-db、notification、web-push | REVIEWED；隔離 failure/recovery PASS |
| 持久化／復原 | instance-lock、json/env-file-store、config-backup | single owner、atomic rename/fsync、backup integrity、staged restore | lock/store/backup/config-restart/preflight | REVIEWED；正式 DR NOT RUN |
| 可觀測性 | logger、issue/task tracker、system-monitor、health-routes | redaction → suppression → diagnostics；DB/core worker 決定 readiness | observability/public-health、runtime smoke | REVIEWED；不以設備 offline 觸發 ready failure |
| 部署／CI | Dockerfile、Compose/build overlay、release/update/preflight scripts、ci/publish workflows | immutable base → image identity → Repository gate → GHCR；NAS pull/preflight 後才 recreate | deployment、CI scope/contract、release-build/preflight | REVIEWED；Hosted 結果另綁最新 HEAD |

主要資料流：Browser → authentication/role/CSRF → API route → service → integration → cache/snapshot；background sampler 取得資料並寫 SQLite／推進 notification state。不能把每次 GET snapshot 變成重新登入、SSH、寫 history 或通知。備份、報表與異動路徑保留原本的一致性與確認流程。

## Coverage Matrix

`P` 代表在本次完整 `npm test` 或指定 runtime gate 實跑通過的相應範圍；`F` 代表隔離 fixture／VM，不是實機或真實 browser；`—` 代表沒有該項證據。測試數不是 coverage 百分比。

| Area | Unit | Integration | Contract | Failure | Recovery | Performance | Smoke | Soak |
|---|---|---|---|---|---|---|---|---|
| Authentication | P | P | P | P | P | — | P | — |
| API contract | P | P | P | P | P | F/cache HTTP | P | F |
| Scheduler／lease | P | P | P | P | P | F/upstream counts | P | F |
| Integrations | P | F | P | F | F | F/cache | 未設定設備 | F |
| SQLite | P | P/real SQLite | P | P | P | P/四種合成資料量 | P | F |
| Frontend lifecycle | P/VM | F/14頁/3tabs | P | F | F | F/timer/cache counts | browser BLOCKED | F/非視覺 |
| Notifications／reports | P | F | P | F | F | — | — | F/排程 |
| Docker／Deployment | P/contracts | 本機 NOT RUN | P | P/preflight | P/fixtures | 本機 NOT RUN | Hosted 另列 | Hosted 另列 |
| Restart／persistence | P | P | P | P | P | — | P/兩次 SIGTERM | F |

新增 regression 不靠 arbitrary sleeps 隱藏 race。SW 使用可控 promise、fake Cache；前端使用 fake timer 與實際 app 函式；SQL 用真正 prepared statement／EXPLAIN opcode 和有界資料。效能工具中的短等待只讓 event-loop monitor 啟動，不是測試同步手段。

## P2 Findings

| ID | Module / File / Line | Symptom / Root Cause | Impact / Reproduction | Fix / Test / Status | Residual Risk |
|---|---|---|---|---|---|
| P2-001 | `db.js:521–625` | 10 個分批候選查詢以計算後的 bucket alias 排序；LIMIT 前仍掃描／排序 retention 範圍 | 長歷史增加同步 CPU／event-loop stall；真實 `EXPLAIN` 出現 Sorter，365d fixture 可重現 | 依既有索引的來源時間排序；單調 bucket 保持結果順序，去重可提早停止；新 SQL tests 及原有 aggregation/atomicity tests PASS；FIXED | `DISTINCT` 仍需要去重暫存結構；完整 cleanup／備份仍受資料量與儲存影響 |
| P2-002 | `server/services/pwa-service-worker.js:28–49` | 任意非 API GET/query variant 可入 cache；cache.put 未綁 event lifetime、quota rejection 未處理；fallback 跨 cache version 查詢 | 1000 query variants 從 13 膨脹至 1013 entries；容量錯誤可造成未處理 rejection／舊版 fallback | 只允許同源固定 public shell、無 query；排除 private/no-store/redirect/error；同步 waitUntil、catch cache failure；限定當前 cache；行為測試 PASS；FIXED | 真 browser quota/update/offline 驗收 BLOCKED；既有 Service Worker client 須由正常版本更新取代 |
| P2-003 | `public/js/app.js:298–307,1189–1205,1225,1290–1313,4839` | WiiM interval 沒有 scoped owner；clear timer 不會使已排入事件佇列的舊 polling callback 失效 | hidden/unrelated page 仍更新 progress；切頁、隱藏、同頁重建後舊 callback 仍可新增 fetch | scoped resource 清理 WiiM timer；pollingGeneration fence 與 visibility guard；100 次切換、3 tabs、14 頁矩陣 PASS；FIXED | 不宣稱所有已經開始的 async fetch 都已 abort；真 browser navigation/visual regression 仍待驗收 |
| P2-004 | `server.js:5439–5650`、`test/ups-runtime.test.js` | adaptive UPS timer 若在 freshness deadline 前極短時間醒來，`sampleUpsIfDue()` 會正確略過讀取，但 sampler 接著重新排完整 5 秒，造成 outage/recovery 最壞額外延遲；CI runtime fixture 又依賴 PATH 中不存在的 `cat`，掩蓋真實 invocation count | Hosted CI 可重現 recovery timeout（約 25.5 秒，`last=null`）；1 ms early wake 可被放大成完整 interval | `upsRemainingSampleDelayMs()` 依最後成功/失敗 attempt 重排「剩餘」deadline，保留原 freshness/singleflight guard；fixture 改用 POSIX shell builtin；新增成功/失敗 early timer、manual sample、active/idle 改變、backward clock 與 invocation counter 回歸；FIXED | 真實 UPS/PPB 裝置與長時間 outage/recovery 仍 NOT RUN；wall-clock 大幅異常只驗證 bounded retry，不代表外部時鐘環境完整驗收 |

P2-001 regression 在基底捕捉 10 個排序路徑；P2-002 在基底捕捉 cache growth、lifetime/quota/fallback；P2-003 的 WiiM 測試基底 3 個失敗，polling matrix 基底 16 PASS/1 FAIL（已排程舊 callback）；P2-004 由 Hosted CI 實際捕捉 UPS recovery timeout，並以 deterministic deadline tests 固化 1 ms early-wake root cause。修復後全部綠燈。修改既有 panel-login assertion 是把 fallback 契約從全域 cache 強化為當前 build cache，同時斷言不再出現舊呼叫，沒有刪測試放寬 gate。

## P3 Findings

| ID | Module / File | Root Cause / Fix | Test / Status |
|---|---|---|---|
| P3-001 | `pwa-service-worker.js:10` | HTML 已引用 `frontend-lifecycle.js`，但 PWA shell 沒列出；補入既有固定 shell | 掃描 SPA executable assets 的預快取完整性測試先紅後綠；FIXED |

沒有為 P3 引進框架或大型重構。原始 P2 範圍發現的 Alpine package revision release blocker 原先依規則列為 P1/OUT OF SCOPE；後續使用者要求把剩餘失敗一併修完，因此另以最小變更刷新 `nut` 與 `tzdata` 精確 revision 並同步 deployment contract，未改 memory limit、gate 或架構。

## Fixes

最終產品程式變更包含 `db.js`、`public/js/app.js`、`server/services/pwa-service-worker.js`、`server.js`，並刷新 `Dockerfile` 的兩個已失效 Alpine 精確 revision；其餘是 regression tests／helpers、可重跑的 benchmark、量測摘要、此報告與必要文件索引。沒有新增 production dependency、DB index、schema migration、external request 或新的全域常駐輪詢。

## Frontend

14 頁：overview、ucg、clients、security、wifi、cloud、nas、wiim、ups、adguard、linuxhost、tools、notify、settings，均納入實際 page polling map 的 VM 測試。驗證首次 hydration/common job 排程、hidden/visible、相同頁面重建、3 個隔離分頁、100 次快速切換及舊 callback 無效化。

Chart instance、downsampling、pinned MutationObserver 與 NAS SSE 的 owner／teardown 已檢視，既有對應 regression 通過；沒有改 Chart.js 或取樣資料語意，**不把這次測試當成所有重要 peak/event 在所有圖表都完整保留的證明**。bootstrap/action dispatcher/CSP 未放寬。SW 不 cache API/health、任意私有路徑、query variants，network response 成功不因 cache 寫入失敗而失敗。

真 Chromium/Playwright 嘗試在導向隔離 localhost 時被 `ERR_BLOCKED_BY_ADMINISTRATOR` 阻擋。狀態為 **BLOCKED**，沒有成功截圖或真實 UI／多 tab 視覺驗收；沒有停用管理政策來繞過限制。

## SQLite Performance

隔離 temp DB，沒有使用正式 DATA_DIR。固定 2026-09-18 時間；每 600 秒一點、一個 history series、兩個 telemetry devices，並額外放入等量 1m rollups 以測試 raw/rollup 路徑。這是合成壓力分布，不是實際 retention 運作一年的狀態。每個候選查詢 warm-up 後 20 次，同一 CPU/runtime 比較。

| 合成天數 | History raw rows | Telemetry raw rows | DB bytes（前後一致） | History candidate median 前→後 ms | Telemetry candidate median 前→後 ms |
|---|---:|---:|---:|---:|---:|
| 30 | 4320 | 8640 | 4005888 | 0.502 → 0.036 | 3.482 → 0.047 |
| 90 | 12960 | 25920 | 11689984 | 1.230 → 0.031 | 10.847 → 0.048 |
| 180 | 25920 | 51840 | 23355392 | 2.651 → 0.032 | 22.596 → 0.047 |
| 365 | 52560 | 105120 | 47525888 | 5.429 → 0.032 | 48.203 → 0.046 |

WAL 在量測前執行 checkpoint，前後均為 0 bytes；不是宣稱運作中的 WAL 永遠為零。30d cleanup 前後同樣處理／刪除 22,464 rows、建立 22,464 rollups，**549.054 → 307.373 ms**。90/180/365d 的完整 cleanup **NOT RUN**；那些尺寸實際跑的是候選 SQL、history/telemetry read 與 backup。沒有拆開 bucket transaction 或犧牲 atomicity 換速度。

可重跑：
```bash
git worktree add --detach ../smarthub-p2-base 5db2b72d86ada93f46297e4d974f7dcedb93dcaa
# 兩個 source root 都使用 .nvmrc 與同一 lockfile 安裝依賴；不要使用正式 data。
env -u NODE_PATH node --expose-gc scripts/p2-performance-audit.js ../smarthub-p2-base /tmp/p2-before.json
env -u NODE_PATH node --expose-gc scripts/p2-performance-audit.js . /tmp/p2-after.json
```

## Event Loop / CPU

365d telemetry candidate 的 20 次 CPU time **968.315 → 1.211 ms**，event-loop maximum **51.708 → 1.330 ms**；max 是該 fixture measurement window，不是網站 SLA。30d cleanup CPU **629.887 → 389.393 ms**，event-loop max **10.633 → 5.218 ms**。CPU 百分比可能超過 100%（runtime/background GC/native 工作）；本次不以百分比相除宣稱核心使用率等比例下降。

沒有 Worker Threads，也沒有把 async syntax 當作改善。SQLite 備份 hash/JSON、報表聚合等仍可能有同步成本；目前證據只支持本次有界候選查詢修正。

## Polling / Upstream Requests

使用真正 `device-collector-cache` 加隔離 HTTP server，以 1 與 20 個 client、outage/recovery 驗證。不是對正式 Controller／NAS 發出請求，也不代表所有上游 endpoint 都有相同表現。

| 場景 | Upstream before | Upstream after | Request p95 before→after ms |
|---|---:|---:|---:|
| 1 client | 1 | 1 | 44.931 → 46.503 |
| 20 clients | 1 | 1 | 17.753 → 16.369 |
| 20 clients / outage | 2 | 2 | 8.578 → 7.372 |
| 20 clients / recovery | 1 | 1 | 7.276 → 4.647 |

此表確認既有 coalescing 沒被破壞，**不是本 PR 新增的上游節省**。冷啟動 HTTP 數字與小幅 latency 差異不當作顯著效能改善。queued frontend callbacks 的額外請求則由新 regression 直接捕捉。

## Observability

已審查 logger redaction/context、issue suppression、task heartbeat/stuck、system samples 60 筆與 health routes。Liveness 為 `/health`/`/healthz`；readiness 檢查 SQLite/core worker；外部 integration operational health 另列，不能直接當容器 ready failure。隔離 smoke 真正取得 health=200、ready=200。

用真 UPS observability state machine 做 1000 次相同失敗（合成 clock 每次 +3000ms）與一次恢復：前後均 **12 個事件、1840 bytes JSON event payload**。這是 suppression 行為數據，不是實跑 50 分鐘 outage，也不是 Docker stdout 容量。正式 daemon log rotation 設定無法取得；Compose 沒有明確 log driver/rotation，記為部署待確認，沒有無證據更換 logging driver。

## Docker Resources

維持 SmartHub **256 MiB**、NAS Monitor **96 MiB**，沒有提高 limit。實際 Compose 已有 UID/GID 1000、read_only、cap_drop ALL、no-new-privileges、PID 256/64、tmpfs 32m/16m、loopback host bind、內部 monitor-backplane 及專用 data/config mounts。NAS monitor 審查到 bounded semaphore/queue、list cache/singleflight、response caps、allowlist、socket/request shutdown；單元假 Docker socket 測試不等於宿主權限驗收。

本機 Docker/Compose/build、96/256MiB container 實測、NAS monitor enabled 實機、GHCR pull 和 volume owner 驗收 **NOT RUN/BLOCKED**；Hosted Repository gate 能執行的部分另以 latest HEAD run 記錄。沒有為了測試操作正式 NAS、清 volume 或覆蓋 config。

## Test Coverage / Test Results

| Test | Result | Evidence / 邊界 |
|---|---|---|
| 基底 npm ci | PASS / Hosted transfer | 真正依 lockfile 安裝 Node24 依賴，再驗 hash 轉移；不是本機網路 npm ci |
| 基底 npm test | PASS 755/755 | 非 root、unset NODE_PATH、exact base worktree |
| 新 regression 對基底 | 預期 FAIL | SQL sorting、SW cache/lifetime、WiiM timers、queued polling 均實際捕捉 |
| 最終修復樹 npm test | PASS 798/798 | Node 24.18.0、非 root、移除全域 NODE_PATH；0 fail/skip/cancel，本機重跑 32.156 秒 |
| npm run check:js | PASS | 真執行 |
| npm run check:css | PASS | checked-in CSS 未重建／未修改 |
| git diff --check | PASS | 真執行；最終文件再驗 |
| npm run test:smoke | PASS | admin/readonly login、403 write/CSRF、200 valid-CSRF、兩次 SIGTERM exit0、restart persistence |
| npm run test:soak | PASS | 90059ms，tick20ms；最終 timer/SSE/session/collector/nonexpected handle 皆0 |
| npm audit --audit-level=low | 本機 BLOCKED | registry DNS；Hosted latest HEAD gate 另列 |
| 真瀏覽器 E2E | BLOCKED | localhost navigation 被 Chromium 管理政策拒絕 |
| Docker/Compose/SBOM/Trivy/Gitleaks | 本機 NOT RUN | 無 Docker/scanner；Hosted latest HEAD gate 另列 |
| 24h/72h／實機復原 | NOT RUN | 不以短 soak/unit/CI 推定 |

最初本機測試 753/755：一個 root 身分繞過檔案權限語意，另一個環境 NODE_PATH 把全域 Autoprefixer 注入 Tailwind。換成非 root 並移除 NODE_PATH 後，**未修改 production source 即基底 755/755 PASS**。另外曾有既有 panel-login regex 與新 current-cache fallback 不一致；已強化 assertion 並完整重跑 798/798。保留第一個錯誤和原因，不靠反覆 retry 掩蓋。

工具單次命令約 30 秒的外部終止曾中斷合併的 long-running checks；那不是 application timeout。之後在同一次稽核中取得完整 90.059 秒完成紀錄，不把中斷的短執行算通過。

## Before / After

| Metric | Before | After | Interpretation |
|---|---:|---:|---|
| 365d telemetry candidate median | 48.203ms | 0.046ms | 實際 query／固定 fixture |
| 20 次同查詢 CPU | 968.315ms | 1.211ms | 同 runtime；不含造資料 |
| 同 window event-loop max | 51.708ms | 1.330ms | monitor resolution1ms |
| 30d 完整 cleanup | 549.054ms | 307.373ms | 相同處理資料量 |
| 365d backup duration | 50.580ms | 50.670ms | 無改善宣稱 |
| 365d backup sampled peak RSS | 183635968 bytes | 184463360 bytes | 沒有下降；定時取樣可能漏瞬間同步峰值 |
| 同 backup heap after | 5968808 bytes | 5968848 bytes | 沒有實質改變 |
| 365d DB／checkpoint後 WAL | 47525888／0 bytes | 47525888／0 bytes | 無 schema/index 膨脹 |
| 1000 SW query variants 後 entries | 1013 | 14 | 真 renderer 的 VM/cache fixture；有限 shell 多一個 helper |
| Hidden WiiM active timers | 1 | 0 | deterministic lifecycle fixture |
| Hidden 30 次 tick 的 DOM updates | 30 | 0 | 不是 30 秒 wall-clock soak |
| 20client upstream requests | 1 | 1 | 維持原有 coalescing |
| 1000 failure 的 log events/bytes | 12／1840 | 12／1840 | 原有 suppression，不是全站 log growth |
| 短 soak | NOT COMPARABLE | 90059ms PASS | 只跑修復後；RSS52.5→75.3MiB，heap5.9→10.6MiB，peak heap11.1MiB |

沒有測得正式 idle/active/report resource baseline，不捏造這些欄位。RSS 沒下降的項目照實保留，沒有把所有微小差異都當成改善。

## Deployment Impact

`.env`：無變更；migration：無；volume/config：無變更；image：尚未部署，合併後仍需既有 image build/release；NAS update：未執行。正式 TLS、密碼、allowlist、安全 gate 均未放寬。

Rollback 使用先前成對的不可變 image/tag/digest，再按既有 preflight/update 流程；不刪 volume、不回復舊 DB schema。前端需走正常 build revision／Service Worker 更新，可能仍有舊 client 等待 refresh。PR 保持 Draft，沒有 merge 或 auto-merge。

## CI Follow-up

初次 PR gate 曾先在 Docker build 暴露 Alpine mutable repository 與 exact revision pin 不一致（`nut 2.8.3-r4 → r5`、`tzdata 2026c-r0 → 2026d-r0`），後續另一輪又在 UPS production runtime recovery 暴露 sampling deadline 延遲。兩者都沒有用 retry 或降低 gate 掩蓋：Docker pin 與 contract 已同步刷新；UPS deadline root cause、fixture 與 5 個新增 regression 已完成。

程式／測試修復 HEAD `0633c51c4ffed4e9da842e983fa2bf0f934dd2b1` 的 **SmartHub CI run #95 / Repository gate SUCCESS**。該 run 實際通過 secret scan、Node 24 locked install、JavaScript syntax、完整 tests、CSS、production dependency audit、Compose profiles、production image build、SQLite preflight、production container runtime smoke、blocking short soak、SBOM/Trivy、repository hygiene 與 exact-head release evidence。Run URL：<https://github.com/steven87090799/unifi-smarthub/actions/runs/35332764575>。

文件同步 commit 會形成新的 PR HEAD；最終交付以 PR body 記錄該最新 HEAD 的 GitHub Actions 結論，避免在同一 commit 內容中自我嵌入未知 SHA。

## NOT RUN / BLOCKED

真 Controller／SSH／NAS／UPS／PPB／WiiM／AdGuard、real notification delivery、NAS socket/permission、正式備份還原/DR、registry pull、24/72h 均 NOT RUN。真 Chromium 被環境管理政策 BLOCKED。本機 npm registry/Docker/scanner BLOCKED；CI 的結果只記錄實際完成的 latest HEAD，未完成者不得寫 PASS。完整 90/180/365d cleanup、正式 report latency 與 idle resource profile 沒有量測。

## Residual Risks

SQLite 仍為同步單一連線，cleanup 原子 bucket 的極端資料量、其他 query/backup/report、真磁碟性能仍可造成 stall。樣本密度不是每 5 秒運作一年的極限資料量。短 soak RSS 上升不能證明 memory leak，也不能排除長期 leak；需受限容器長測。SW 更新、Chart 視覺、網路故障／恢復的真 browser 操作仍未驗收。已發出的 async fetch 不在本次「排程舊 callback」修復的全面取消保證內。Docker socket 權限與 daemon log rotation 需部署端確認。

## Final Status

**已完成有證據支持的 4 P2／1 P3 修復，並完成後續 Alpine release blocker 修復；最終修復樹本機 798/798 PASS，程式修復 HEAD 的完整 Repository gate 亦 SUCCESS。** 交付仍維持獨立 Draft PR；真實設備、真瀏覽器、正式 NAS/cgroup、24h/72h 等上述 NOT RUN/BLOCKED 不因 CI 成功而視為完成。Latest HEAD 的 GitHub Actions 結論以 PR body 與最終交付紀錄為準。沒有因為目前 gate 綠燈而宣稱軟體百分之百無 bug。
