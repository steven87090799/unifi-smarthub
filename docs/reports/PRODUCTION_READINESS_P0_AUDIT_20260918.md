# SmartHub 獨立 P0 Release Blocker 審查報告 — 2026-09-18

## Executive Summary

| 項目 | 本次證據 |
|---|---|
| Repository | `steven87090799/unifi-smarthub` |
| Repository URL | https://github.com/steven87090799/unifi-smarthub.git |
| Base branch | 任務開始時重新讀取的 `origin/main` |
| Base SHA | `5db2b72d86ada93f46297e4d974f7dcedb93dcaa` |
| Base tree SHA | `170a306e73c049ffb9cb249b108420ce9fe8867b` |
| Task branch | `codex/p0-release-blocker-audit-20260918` |
| Final SHA | 本報告所在 Draft PR 的最新 HEAD；完整 40 位 SHA、tree SHA、run URL 與結論以 PR body「交付證據」為準。不可把 Base SHA 或歷史 run 當成 Final SHA。 |
| Scope | 全 repository P0 風險搜尋、主要安全／資料／啟動／部署邊界審查、最小修復與隔離回歸驗證 |
| Confirmed P0 / Fixed P0 / Unresolved P0 | **2 / 2 / 0** |
| 程式層尚未修復的已確認 P0 Release Blockers | **0** |
| 本地程式驗證狀態 | **P0_CLEARED_CODE_VALIDATED** |
| 實機驗收 | **BLOCKED**：未提供隔離且明確授權的 staging 設備；未操作正式 NAS 或真實設備。 |
| PR 規則 | Draft、base `main`；不 merge、不 auto-merge、不 force push。 |

此結論只涵蓋本次有證據確認的 P0，不代表沒有未知 Bug，也不代表正式 NAS 可直接放行。
報告不能包含自身 commit 的固定自指 SHA；交付時另讀回並記錄完整 Final SHA 與該 HEAD 的 CI。
如果 PR HEAD 改變，舊測試／CI 結論不得自動沿用。

## 1. 版本、環境與證據取得

任務開始時沒有既有工作目錄或他人未提交修改；GitHub 開放 PR 搜尋未找到相同目的 PR。
已先閱讀 `CLAUDE.md`、`AGENTS.md`、`CONTEXT.md`、README、backend/frontend map、
architecture、production release checklist、staging acceptance 與 observability。

本機無法解析 `github.com`，因此沒有把 clone 失敗冒充成功。透過已授權 GitHub 連線，
在本任務分支建立暫時的隔離工作流程：唯讀取得上述 exact base、完整 Git history、
Node runtime 與 `npm ci` 產物，再以 Git bundle 重建本地 repository，核對 Git HEAD、
tree 及 SHA-256。來源準備 run 為 `35294190428`，artifact 為 `10527535019`；
這是本次新執行的環境準備證據，**不是最終 PR CI**。

| 環境 | 實際狀態 |
|---|---|
| 執行日期／時區 | 2026-09-18／Asia/Taipei |
| 初始 Node / npm | 22.16.0 / 10.9.2；不作專案正式測試版本 |
| 隔離測試 Node / npm | **24.18.0 / 11.16.0**，與 `.nvmrc` 一致 |
| SQLite | better-sqlite3；本次載入 SQLite **3.53.2** |
| 測試 UID | **1000**；避免 root 令權限故障注入測試失去意義 |
| 本機 Docker / Compose / Trivy / Gitleaks | **BLOCKED**：未安裝；由 exact-head hosted gate 另行驗證 |
| 生產 `.env`、DB、volume、設備 | 未讀取或修改 |
| 暫時交付流程 | 只在本任務分支執行；最終 tree 移除臨時 workflow，不發布映像、不修改 `main`。 |

### 歷史報告重新判讀

- `PRODUCTION_RELEASE_BLOCKERS_20260907.md`：安全預設、password policy 與 Express 版本仍有相應實作，但沒有覆蓋本次大小寫授權繞過；其 CI-only／未等待結果段落不是本次 PASS 證據。
- `PRODUCTION_LONG_RUN_HARDENING_REPORT.md`：明確為歷史 PR；streaming backup 與 rollback 機制仍存在，但其完整性結論不能排除本次 WAL checkpoint 漏檢。
- `POST_MERGE_AUDIT_HARDENING.md`：WiiM artwork pinning、read/write separation 等以目前程式與測試重新檢查；所有歷史 SHA、測試數與 soak 結果不沿用。

## 2. Coverage Matrix

對 base 的 **261 個 tracked files** 建立檔案／雜湊清單並做全樹風險搜尋；
大檔採入口、資料流及危險 sink 分段審查。這是邊界導向審查，不是宣稱逐字形式化證明，
也不是把第三方 minified bundle 視為已人工完整審查。
完整檔案清單、風險命中行號與本次命令輸出保留於交付 evidence package。

`REVIEWED` 表示此模組 P0 邊界已查核，不等同實機 PASS。
測試名稱以下可省略共同的 `test/` 前綴。

| Module | Files | Entry Points | Security / Data Boundary | Tests | Status |
|---|---|---|---|---|---|
| Authentication / sessions | `server/middleware/panel-security.js`、`server/routes/panel-auth-routes.js` | login、logout、status、Basic／cookie auth | password、idle／remember expiration、隨機 token、cookie flags、throttling | `panel-login`、`panel-security` | REVIEWED |
| Authorization / CSRF / Origin | 同上、`server.js`、`server-mock.js` | 所有 `/api` mutations | admin、Readonly、CSRF、Origin、forwarded headers、大小寫路由 | `panel-security-path`、`write-route-contract` | FIXED |
| 輸入與 query | `server/policies/*-input-policy.js`、`express5` 邊界 | body、params、query | 型別、長度、exact keys、MAC／ID、prototype-like keys、控制字元 | `write-input-policy`、`query-input-policy`、`express5-regression` | REVIEWED |
| 前端與 XSS 邊界 | `public/js/app.js`、`action-dispatcher.js`、login／CSP／assets routes | 動態文字、HTML、data-action、write controls | escaping、固定 handler、CSP；後端權限為權威 | `frontend-csp-contract`、`frontend-console-ui`、`frontend-runtime-assets` | REVIEWED |
| SQLite / migrations | `db.js` | createHistoryDb、report schema、legacy JSON | transaction、加欄位、唯一鍵修復、來源 JSON 保留、prepared statements | `report-schedule-db`、`history-buffer`、本次故障注入 | REVIEWED |
| History / telemetry retention | `db.js`、telemetry services | flush、rollup、prune | 有界佇列、transaction promotion、retention、claims fencing | `history-downsampling`、`unifi-device-telemetry-db` | REVIEWED |
| Backup / Restore | `server/services/config-backup.js`、restore routes | export v1/v2、stage、startup apply／recover | manifest、checksum、version、staging、WAL、rollback durability | `config-backup`、本次 busy WAL／EIO／ENOSPC 測試 | FIXED |
| 設定儲存 | `server/storage/env-file-store.js`、`json-file-store.js` | connections／settings persistence | 固定檔案、0600、bounded write、fsync、atomic rename、失敗保留 | `env-file-store`、`json-file-store`、`config-restart` | REVIEWED |
| 啟動與 single owner | `server.js`、`server/storage/instance-lock.js` | lock → restore → DB → background → HTTP | restore 前取得 owner、初始化失敗退出、owner 遺失安全關閉 | `instance-lock`、`server-lifecycle`、`config-backup` | REVIEWED |
| Health / shutdown | `observability/*`、`server.js` | `/health/ready`、SIGTERM | SQLite unavailable 不回 Ready；有界 drain、flush／close | `observability`、`server-lifecycle`、runtime smoke | REVIEWED |
| Docker broker | `nas-monitor/server.js`、Dockerfile、Compose | inventory、logs、start／stop／restart | key auth、完整 64 hex ID、allowlist、protected containers、caps、timeouts | `nas-monitor`、`docker-action-policy` | REVIEWED |
| NAS Monitor client / SSE | `nas-monitor-client.js`、`server.js`、SSE service | broker proxy、stream、Docker mutation | admin API、固定 routes、trust tuple、無不明 mutation retry | `nas-monitor-client`、`nas-monitor-sse`、`sse-backpressure` | REVIEWED |
| UniFi / Site Manager | `server.js`、`site-manager-client.js`、`unifi-auth-retry.js`、traffic-list／threat services | Controller reads、block、PoE、WiFi | input policy、bounded auth retry、explicit admin、verified TLS | `unifi-auth-retry`、`site-manager-client`、`threat-ip-*` | REVIEWED |
| UniFi Device SSH | `unifi-device-thermal-ssh.js`、SSH pool／stream／host-key policy | selected device telemetry | Controller-known identity、MAC allowlist、literal IP、固定唯讀 command、pinning、deadline／output cap | `unifi-device-thermal-ssh`、`ssh-*` | REVIEWED |
| UGREEN NAS | `server.js`、NAS token／login／retry services | login、read-only NAS API | token generation fence、單次 auth retry、TLS／CA、錯誤遮罩 | `nas-login-singleflight`、`nas-token-generation`、`nas-request-retry` | REVIEWED |
| UPS / PPB | `ppb-client.js`、UPS services／jobs、`server.js` | polling、PPB events、pwrstat／NUT | execFile 固定 argv、TLS policy、strict source、GET snapshot、事件去重 | `ppb-client`、`ppb-event-sync`、`ups-runtime`、`ups-readonly-contract` | REVIEWED |
| WiiM / artwork | `wiim-client.js`、`wiim-art-proxy.js`、command policy／routes | commands、artwork URL／redirect | GET 不 mutation、allowlist、DNS pinning、IPv4／IPv6／metadata deny、每跳驗證、MIME／cap | `wiim-art-proxy`、`wiim-client`、`wiim-command-*` | REVIEWED |
| AdGuard | `adguard-client.js`、service policy／routes | protection／service-policy mutation | admin、fixed control path、TLS／CA、明確 HTTP opt-in | `adguard-client`、`adguard-route`、`adguard-service-policy*` | REVIEWED |
| UCG / Linux SSH | `server.js`、共用 SSH modules | 固定 hardware／Linux telemetry | production 預設需 host key、沒有由 request 拼接 shell command | `ssh-host-key-policy`、`ssh-command-stream`、`ssh-connection-pool` | REVIEWED |
| Notifications / Web Push / Telegram | `notification-delivery.js`、`web-push*`、`telegram-command-bot.js` | admin settings、subscription、allowed chat commands | secret masking、HTTPS push、chat allowlist、一次性確認、partial delivery 不盲重送 | `notification-delivery`、`web-push-*`、`telegram-command-bot` | REVIEWED |
| Background / reports / PWA | samplers、report runner／schedule、activity lease、PWA service | timers、claims、cache、service worker | non-overlap、lease／fencing、bounded state；不快取 credential response | `report-runner`、`report-schedule*`、frontend lifecycle | REVIEWED |
| Deployment / CI / release | Dockerfiles、Compose、`update-nas.sh`、preflight／release scripts、兩個 workflows | build、pull、preflight、up、publish | exact commit identity、volume guard、no destructive production teardown、required gate | `deployment-contract`、`release-build`、`ci-contract`、本次 fake docker probes | REVIEWED |
| Secret boundaries | tracked tree、`.gitignore`、`.dockerignore`、logger、backup、workflow | repository、logs、errors、artifacts | 未發現可確認的真實 secret；full-history scanner 必須另以本次 hosted result 判定 | `observability`、backup tests、hosted Gitleaks | REVIEWED |
| 正式 NAS / real integrations / DR | 未連接正式資產 | 真實 device writes、獨立 storage recovery、24/72h soak | 不能用 mock 或 CI 代替 | 實機環境未提供 | BLOCKED |

## 3. Side-effect API 清單

以下「A」表示 authentication + admin + CSRF + Origin/referrer policy；
修復後所有 Express 可接受的 `/API` 大小寫變體也經相同保護。
Origin 不存在時仍需有效 CSRF；這是既有 non-browser client 契約，不是 Origin 偽造放行。
明確偽造 Origin、`Origin: null`、不可信 forwarded headers 不可繞過政策。

| Route | Method | Auth | Required Role | CSRF | Origin | Side Effect |
|---|---|---|---|---|---|---|
| `/api/auth/login` | POST | 驗證 password | admin / readonly | login bootstrap，不要求既有 token | 檢查存在的 Origin/referrer | 建立／輪替 session cookie |
| `/api/auth/logout` | POST | 目前 session（無 session 可冪等退出） | 目前使用者 | 既有 logout 契約 | 同源檢查 | 撤銷 session、清除 cookie |
| `/api/wifi-networks/:id` | PUT | A | admin | 必須 | policy | WiFi enabled |
| `/api/wifi/qr` | POST | A + route admin | admin | 必須 | policy | 處理敏感 WiFi credential、生成 QR；非設備 mutation |
| `/api/security/threat-blocks`、`/:id` | POST / DELETE | A + route admin | admin | 必須 | policy | 持久化與上游 threat block |
| `/api/ui-preferences` | POST | A | admin | 必須 | policy | UI JSON |
| `/api/client-aliases` | POST | A | admin | 必須 | policy | alias JSON |
| `/api/device/restrict` | PUT | A | admin | 必須 | policy | Controller client restriction |
| `/api/poe/power-cycle` | POST | A | admin | 必須 | policy | PoE power cycle |
| `/api/speedtest` | POST | A | admin | 必須 | policy | Controller speed test |
| `/api/security/settings` | POST | A | admin | 必須 | policy | defense settings |
| `/api/notifications/settings` | POST | A | admin | 必須 | policy | notification credential／policy |
| `/api/notifications/test` | POST | A | admin | 必須 | policy | 外部訊息送出 |
| `/api/nas/docker/:id/:action` | POST | A + target allowlist | admin | 必須 | policy | Docker start／stop／restart |
| `/api/nas/alerts/:id/ack` | POST | A | admin | 必須 | policy | acknowledge |
| `/api/nas/alerts/config`、`/:metric` | POST / DELETE | A | admin | 必須 | policy | broker alert policy |
| `/api/settings` | POST | A | admin | 必須 | policy | scheduler／app JSON |
| `/api/connections` | POST | A | admin | 必須 | policy | `.env` 與 integration reconfiguration |
| `/api/config/restore`、`/v2` | POST | A + route admin | admin | 必須 | policy | staged restore，另需 `RESTORE` confirmation |
| `/api/reports/run` | POST | A | admin | 必須 | policy | report／delivery／history |
| `/api/wiim/history` | DELETE | A | admin | 必須 | policy | WiiM local history |
| `/api/wiim/cmd` | POST | A + command allowlist | admin | 必須 | policy | 允許的 WiiM write；高風險 command 再確認 |
| `/api/adguard/protection` | POST | A | admin | 必須 | policy | protection enabled |
| `/api/adguard/service-policies`、`/:id` | POST / DELETE | A + route admin | admin | 必須 | policy | service policy |
| `/api/web-push/subscriptions` | POST / DELETE | A + route admin | admin | 必須 | policy | subscription DB |
| NAS Monitor `/api/docker/containers/:id/:action` | POST | API key | broker allowlist | 非 cookie API，不適用 | 非 browser trust boundary | 只允許 start／stop／restart；inspect 後重驗目標 |

安全方法另核對：WiiM GET command 只允許 read；UPS GET 只取 snapshot；
backup exports、Docker logs、notification chat-id 偵測等敏感 GET 另有 route admin 或既有檢查。
一般讀取仍可能更新 cache、觸發唯讀上游 fetch 或租約，不將它們誤報成無副作用的純函式。

## 4. P0 Findings

### P0-001 — Readonly 可透過 API 大小寫繞過管理寫入防護

- **Priority / Module**：P0 / Authorization。
- **File / Line**：`server/middleware/panel-security.js`，base 的 `protectWrites`；修復後 path helper 約 L9、protected safe paths 約 L133、write gate 約 L465–468。全域掛載在 `server.js` 約 L397–402。
- **Symptom**：Readonly 對 `/API/connections/` POST，不帶 CSRF／Origin，正式程式與 mock 都回 `200`，且真的修改隔離 `.env`。
- **Root Cause**：Express route 預設 case-insensitive；middleware 卻以 case-sensitive `/api/` 前綴判定是否需要 admin／CSRF／Origin，造成 router 與 security classifier 不一致。
- **Impact**：已登入 Readonly 可越權改 integration 設定，或命中只依賴全域防護的設備 mutation API。不是聲稱匿名可直接登入。
- **Reproduction**：`node --test --test-name-pattern="mixed-case readonly" test/write-route-contract.test.js`；unit edge cases 見 `test/panel-security-path.test.js`。
- **Evidence**：修復前兩個實際 runtime 都得到 `{"ok":true,"changed":1,"restartRequired":[]}`，預期 403；before log 保留於 evidence package。
- **Fix**：將 security classification 使用的 path 統一 lowercase，對 protected safe path 同步移除可選尾斜線；保持 Express API 相容性，不放寬任何驗證。
- **Regression Test**：POST／PUT／PATCH／DELETE、case variants、尾斜線、Basic／session Readonly、admin 缺少／錯誤 CSRF、惡意 Origin、forwarded spoof、valid admin、protected GET。
- **Status**：FIXED；相關安全／login／正式與 mock 路由套件 **186/186 PASS**。
- **Residual Risk**：新增其他 router／prefix 時仍須共用 security gate；前端隱藏按鈕不能替代後端授權。

### P0-002 — Busy WAL checkpoint 被忽略，回滾副本遺失已提交資料

- **Priority / Module**：P0 / SQLite Backup–Restore。
- **File / Line**：`server/services/config-backup.js`，`checkpointDatabaseForRollback` 約 L95、durable copy 約 L210、rollback 約 L282、snapshot／journal boundary 約 L341–351。
- **Symptom**：還原回報成功，但 retained rollback DB 缺少原始已提交資料。
- **Root Cause**：`PRAGMA wal_checkpoint(TRUNCATE)` 可能正常返回 `busy` 而非丟出例外；原碼只跑 `quick_check`，接著複製 main DB、替換檔案並刪 WAL／SHM。仍在 WAL 的 committed rows 沒進 rollback copy。原始備份／rollback copy 也缺少 file fsync。
- **Impact**：存在長讀取 transaction（例如另一個 SQLite 診斷 reader）時，回滾副本不是完整原資料，後續故障／回滾可能永久遺失 committed data。
- **Reproduction**：在隔離 DB 開 reader snapshot，另一 writer commit sentinel 後關閉；保持 reader，執行 staged restore。
- **Evidence**：修復前 restore 成功，但 rollback snapshot 的 sentinel **預期 1 筆、實際 0 筆**。不是僅根據理論推估。
- **Fix**：檢查 checkpoint result；busy／未完整 checkpoint 時 fail closed，保留原 DB、WAL、pending。共用 durable copy，對 snapshot／rollback／replacement 做 file fsync，並在 journal 前同步 backup directory 及其 parent。
- **Regression Test**：busy reader 下拒絕替換且保留 committed row，reader 關閉後可成功重試；rollback snapshot fsync 注入 EIO 時原檔不變；替換期間注入 ENOSPC 時完整回滾且可重試；既有 interrupted journal recovery 保留。
- **Status**：FIXED；backup／DB／instance-lock 相關執行 **20/20 PASS**，並納入完整 suite。
- **Residual Risk**：不支援 restore 同時讓其他工具持續寫入同一 DB；真實斷電、磁碟控制器 cache、NAS filesystem durability 尚未實機驗證。

## 5. Root Cause / Fixes / Reverse Review

P0-001 修的是 router 與 authorization policy 的語意差異，不是逐條補前端按鈕或只修單一 endpoint。
P0-002 修的是「可恢復的原始快照」成立前提，而不是忽略 SQLite busy 或吞掉磁碟錯誤。

本地首次 CSS 差異來自全域 `NODE_PATH` 載入不同 Autoprefixer，並非 repository 產物過期。
清除 `NODE_PATH` 後重新驗證完整測試與 CSS gate，輸出與 base 完全一致。
已撤回不必要的 CSS 變更；最終 PR 不修改 UI 產物。

反向審查確認：沒有新增 admin bypass、沒有 TLS 降級、沒有 SQL schema／migration 變更、
沒有正式設定或 DB、沒有 destructive volume 操作、沒有降低 CI gate，也沒有無關重構。
新增測試與 production/mock 共用同一修復；文件只新增本次報告及必要索引。

## 6. Security / Secret Audit

Production 維持 `TRUSTED_LAN_MODE=false`，TLS／CA 與 SSH fingerprint 政策未放寬；
development 或明確 insecure opt-in 不當成 production 安全預設的證據。
固定 SSH command、literal IP／allowlist、deadline／output cap 均有目前版本的測試。

WiiM artwork 檢查所有 DNS answers、每個 redirect、mapped IPv6、private／metadata addresses，
並以 pinned lookup 連線；只有明確設定的 WiiM literal 可以進入相對應例外。
Webhook、Web Push 與管理員指定 integration endpoint 不等同這個 artwork sandbox；
本次沒有證明可由未授權使用者藉它們取得管理 secret 的路徑。

tracked 檔案沒有正式 `.env`、SQLite、private key 或 log。讀取 `.gitignore`、`.dockerignore`、
logger masking、backup environment mask、workflow artifact 範圍；未發現可確認的真實 secret。
這不替代完整 Gitleaks history scan。最終 hosted scan 要以本次 exact-head run 為準；
如發現真 secret 必須遮罩及人工 rotation，不 rewrite history。

## 7. Data Integrity / Migration / Backup / Restore

隔離驗證另包括 fresh install、restart persistence、legacy upgrade、migration 重複執行。
以 SQLite trigger 注入 migration UPDATE failure，確認新增欄位整批 rollback，
原始 report row 與 quick_check 保持正常；移除故障後再次 upgrade／restart 保留原始 row。

Backup v1/v2 的格式、版本、checksum、截斷、staging、confirmation 及 restart-only apply
由現有與新增測試共同驗證。沒有拿正式 DB 測試。
`.env` 不由一般 backup 自動還原；完整 recovery 仍依賴獨立且加密保存的設定備份。

Fault injection 是受控測試，不等於真正 power loss／disk-controller failure。
大於 legacy 43 MiB 的 v2 apply 問題另列 OUT OF SCOPE，不能因小備份測試 PASS 就說所有容量都支援。

## 8. Docker Security / Deployment / Rollback

NAS Monitor profile 預設關閉，mutation／log 預設需明確啟用與 allowlist；
固定完整 container ID，執行前 inspect，protected label／self target 拒絕。
Docker socket 即使 read-only bind mount 也不是唯讀 API 保證；broker RCE 仍具主機高權限風險。

本次用 temporary fake `docker` executable 攔截所有 update 命令：
pull failure、missing image、preflight failure 均在 recreate 前停止；
startup failure 非零傳遞；沒有刪 volume、沒有修改測試 env。
「migration-preflight-failure」只模擬 preflight 的非零 exit，
**不等於已驗證真實 image migration 或自動 rollback**。

現有更新腳本只做 Pull → Preflight → Up → volume identity → `compose ps`，
並沒有健康等待或成對 revision 比對；因此零 exit 本身不能當成上線驗收。
目前 publish workflow 綁定成功 push CI 的 exact SHA，但 moving tags 在 multi-arch scan 前已推送，
且不同 revision 的 publish run 沒有同一 stable promotion lock。未執行 GHCR 發布來測這些情境；
它們列為後續 release hardening，不把尚未證明的資料毀損推定為 P0。

本次不改 image tag、Compose volume identity 或 schema。
回退程式版本前仍要保存目前 DB／WAL／SHM 與設定、確認 image/schema/config 相容；
單純拉回舊 image 不構成完整資料 rollback。
回退本次安全修復會重新暴露兩個 P0，不建議作為故障處置的第一步。

## 9. Test Results

所有 PASS 都是本次實際執行；failure reproduction 是用來證明 bug 存在，不混入修復後 PASS 數。

| Test | Result | Evidence / Boundary |
|---|---|---|
| 本次 exact-base `npm ci` | PASS | source preparation run `35294190428`；不是最終 PR gate |
| P0-001 修復前 unit／真實 production + mock 重現 | FAIL | 未拒絕越權；兩個 runtime 回 200 並 changed=1 |
| P0-002 修復前 busy WAL 重現 | FAIL | rollback sentinel 0，預期 1 |
| P0-002 修復前 backup fsync 注入 | FAIL | 預期 EIO abort 卻無例外，證實沒有做該 fsync |
| P0-001 修復後相關套件 | PASS | 186/186 |
| P0-002 backup／DB／lock 套件 | PASS | 20/20 |
| `npm test` 完整測試 | PASS | **768/768**；0 fail、0 cancelled、0 skipped；Node 24.18.0、UID 1000 |
| `npm run check:js` | PASS | **201 files** |
| `npm run check:css` | PASS | `NODE_PATH` 已清除；與 base 完全一致，沒有 CSS 變更 |
| 隔離 fresh／upgrade／repeat／migration failure／restart | PASS | 原 row 保存，失敗 migration 欄位 rollback |
| 隔離 production preflight `--offline` | PASS | UID 1000，11 checks；未宣稱 image identity 驗證 |
| `npm run test:smoke` | PASS | health／ready 200，admin／readonly login 200，Readonly write 403，missing CSRF 403，valid admin 200，SIGTERM 0/0，restart persistence |
| `npm run test:soak`（90 秒隔離） | PASS | 實測 90,116 ms；最終 timer／SSE／collector／非預期 handles 均 0；無 unhandled rejection／uncaught exception；不是實機或 24/72h |
| Fake Docker update failure probes | PASS | pull／missing image／preflight failure 無 recreate；startup 非零傳遞；不是 real Docker |
| 大型 v2 restore 預期功能 | FAIL | 47,501,754-byte archive 可 stage，但 apply 用舊 43 MiB cap 拒絕；原始資料保留，OUT OF SCOPE |
| `git diff --check` | PASS | 提交前需再次執行；不包含正式 config／DB／secret |
| 本機 Docker build／Compose／SBOM／Trivy／Gitleaks | BLOCKED | 本機未安裝；hosted exact-head 結果另列於 PR 交付證據 |
| 正式 NAS／真實設備／DR／24–72h acceptance | BLOCKED | 未授權／未提供隔離實機，不以 mock PASS 代替 |

本地首次基準在 root 下的權限測試不具有效性；改用 UID 1000 後 11 個 preflight tests 通過，
沒有為讓測試通過而改權限政策。基準另有一次 UPS runtime pending-promise cancellation；
修復後完整 768 tests 沒有 cancellation，但不把一次後續通過當成已查明所有偶發測試根因。

`npm audit --audit-level=low` 與最終 hosted gate 的實際結果，
在交付 evidence／PR body 另外綁定執行 revision；不能將本表未寫 PASS 的項目推定通過。
90 秒模擬不等於 24/72 小時實機。

## 10. Residual Risks / OUT OF SCOPE

| ID | 分類 | 證據與處置 |
|---|---|---|
| OOS-01 | P1 / OUT OF SCOPE | 大型 v2 restore 的 final validation 沿用 43 MiB cap；本次隔離 45 MiB fixture 已重現，rollback 保留原 sentinel。未擴大本 PR 修容量功能。 |
| OOS-02 | P1 / OUT OF SCOPE | updater 沒有 ready wait／paired revision verification／automatic rollback；fake docker 已證明不同 image revision 與不健康狀態仍可零 exit。正式 deployment 必須另行驗收。 |
| OOS-03 | UNCONFIRMED P0 / release hardening | publish moving tags 早於平台 scan，且跨 SHA runs 可競爭 stable；未證明本次有錯誤映像／資料毀損，沒有假裝執行實際 registry race。 |
| OOS-04 | P1 防禦縱深 / OUT OF SCOPE | NAS Monitor Axios client 沒有在 factory 明確禁用 redirect；custom API-key header 的跨 origin 流向仍應增加 wire test。尚未證明未授權者可控制 redirect 或取得真 key，不列 P0。 |
| OOS-05 | UNCONFIRMED / test reliability | 首次基準 UPS runtime cancellation 的根因未確定；保留原始失敗 log，不刪測試，修復後完整 suite 通過。 |
| ACCEPT-01 | BLOCKED | UniFi／NAS／UPS／WiiM／AdGuard／SSH／Docker socket 真實驗收、獨立儲存還原與 rollback 演練。 |
| ACCEPT-02 | BLOCKED | 真實斷電 durability、長時間資源趨勢、24/72h soak。 |
| ACCEPT-03 | 已知風險 | Docker socket 的 host-root-equivalent 權限；同 volume backup 不是 disaster recovery；必須保護獨立加密 `.env`。 |

## 11. Final P0 Status

**P0_CLEARED_CODE_VALIDATED**：本次確認的兩個 P0 已修復，修復前失敗／修復後通過證據完整，
完整可執行程式驗證通過；真實環境仍 BLOCKED，不使用 `P0_ACCEPTANCE_COMPLETE`。

交付時必須讀回 Draft PR 的最新 HEAD、`SmartHub CI / Repository gate` 對應 run／job
與 conclusion，並更新 PR body 的「交付證據」。如果最新結果仍 queued／in_progress，
就記 PENDING；如果失敗就修復根因並重新驗證，不得沿用舊綠燈。
