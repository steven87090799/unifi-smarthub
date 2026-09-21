# SmartHub P1 長期可靠性獨立審查與修復 — 2026-09-18

## Executive Summary

本次從執行當下最新 `origin/main` 獨立開始，未採用其他 P0／P2／歷史 audit 分支的修復。確認 **7 項 P1、修復 7 項**；這是本次有重現證據的 finding 集合，不代表所有真實設備或所有長期故障組合已驗收。

核心修復包括：跨批次 rollup 覆蓋資料、巢狀遙測與 null 加權錯誤、UniFi 舊設定登入競態與登入風暴、SQLite 持續寫入失敗造成緩衝無界成長、WiiM／NAS 舊設定回應污染新資料，以及 cleanup 首次同步失敗後永不恢復。新增 18 個回歸測試，使用實際 owner／production assembly 或隔離 SQLite；沒有以 mock 的重新實作取代待測根因。

365 天等量資料模擬採 **1 個 series、每分鐘 1 筆、525,600 筆**，不是已運作 365 天。原版 raw 與 rollup 合計僅保留 429,120 筆樣本計數，修復版完整保留 525,600 筆並保留巢狀數據。正確聚合需要更多統計欄位與運算，查詢時間、部分記憶體使用增加，未宣稱所有效能指標改善。實際短 soak 與真實 NAS 長期驗收嚴格分開。

## Base / Final SHA 與執行環境

| 項目 | 證據／界線 |
|---|---|
| Repository | `steven87090799/unifi-smarthub` |
| Base SHA | `5db2b72d86ada93f46297e4d974f7dcedb93dcaa` |
| Base tree | `170a306e73c049ffb9cb249b108420ce9fe8867b` |
| 獨立分支 | `codex/p1-long-run-reliability-20260918` |
| Final SHA | 以本文件所屬 PR 的最新 HEAD 與該 HEAD 的 Actions 為準；包含自身的 commit 無法在內容中預先寫入自己的 SHA。交付時 PR comment／最終回覆另記完整值。 |
| 本地工作樹 | 從 exact-base Git bundle 建立；原始樹乾淨，另設 baseline worktree，沒有 reset／clean 其他人的修改。 |
| Node／npm | 實測 Node `v24.18.0`、本地 npm `10.9.2`。Node 與 native dependencies 從隔離 Actions locked install 匯入；不是用原先不符專案要求的 Node 22 宣告通過。 |
| SQLite | `better-sqlite3` 鎖定依賴、SQLite `3.53.2`；只使用新建 temporary DATA_DIR。 |
| Docker／Compose | 本地工具不存在，標為 BLOCKED；Hosted CI 的隔離建置／Compose／重啟結果獨立記錄。 |
| 網路／Git | 本地 GitHub／npm DNS 不可用，原生 clone／fetch／push／npm audit 受阻。以 GitHub connector、branch-only Actions 匯出 exact-base bundle 與依賴；修復經正常 fast-forward commit／push 交付。沒有 force push。 |
| Bootstrap Actions | `35314924234`，Prepare isolated P1 audit workspace 成功；只證明取碼與 `npm ci`，不是最終 Repository gate。 |
| 安全 | 未接觸正式 NAS、真實設備、正式 DB、Volume 或部署設定；未 merge、未 auto-merge、未降低 TLS／gate／stop grace period。 |

初次非 root baseline 為 755 項、754 PASS、1 FAIL，表面為 CSS 不一致；交付前比對 hosted 產物後，確認真正根因是本機 `NODE_PATH` 載入全域 autoprefixer，而非 repository 的 CSS 過期。清空 `NODE_PATH` 後，以相同 Node 24.18.0、locked dependencies 與非 root 身分重跑：baseline **755／755 PASS**，修復版 **773／773 PASS**。保留原始失敗紀錄並更正歸因；最終不修改 CSS。最初 root 執行的權限 fixture 差異亦未藉刪改測試放行。

已閱讀 `CLAUDE.md`、`AGENTS.md`、`CONTEXT.md`、README 的相關部署段落、backend／frontend map、architecture、release checklist、staging acceptance、polling intervals、observability。大型 source 以 symbol／route 定位並追 caller；歷史報告不作本次 PASS 證據。

## Coverage Matrix

「審查」表示追蹤所列路徑與生命週期；「測試」僅指列名的本次執行測試。未逐行審閱整個 repository，未執行真實設備全故障矩陣；不能把有單元測試解讀為該整合完整生產驗收。

| Module | Files／Entry Points | Dependencies／Lifecycle | Tests | Status |
|---|---|---|---|---|
| 1. 活動 lease | `activity-lease.js`、`/api/heartbeat` | per-tab session→scope→expiry／sequence→prune | `activity-lease.test.js` | 審查＋自動測試；實際瀏覽器多使用者 NOT RUN |
| 2. 背景取樣 | `adaptive-sampler.js`、`backend-sampler-registry.js`、`device-sampling-policy.js` | start→單一 collect→finally 排程→rebuild／stop | 同名 3 組測試、runtime-soak | 審查＋自動測試；未確認新 P1 |
| 3. SQLite history | `db.js`、`history-aggregation.js`、history API | buffered insert→transaction→raw/rollup→retention→checkpoint | history／telemetry DB、P1 integrity／backpressure／recovery | P1-001、002、005、007 FIXED |
| 4. Instance／migration | `instance-lock.js`、`db.js migrateFromJson` | claim→2 秒 renew→8 秒 lease→close／restart | `instance-lock.test.js`、DB／smoke | 審查＋隔離測試；實體停電／正式 migration NOT RUN |
| 5. 備份 | `config-backup.js`、SQLite backup／restore runtime | 有界格式、臨時檔、原子提交與清理 | `config-backup.test.js` | 相關路徑審查；真實磁碟滿／DR NOT RUN |
| 6. UniFi Controller | `server.js` auth／`rebuildClients`、`unifi-auth-retry.js` | login single-flight→cookie/CSRF→401/403→generation→shutdown | `unifi-auth-retry.test.js`、`p1-controller-session.test.js` | P1-003、004 FIXED |
| 7. Site Manager | `site-manager-client.js` | 有界分頁／timeout／429 retry、proxy policy | Site Manager／transport 測試 | 審查＋自動測試；雲端實際限流 NOT RUN |
| 8. UniFi Device | telemetry snapshot／service／thermal SSH | sampler→Controller→最多 2 個 SSH→fresh-only history | `unifi-device-*`、P1 telemetry conservation | 審查＋自動測試；硬體型號 NOT RUN |
| 9. 一般 SSH／Linux | `ssh-connection-pool.js`、`ssh-command-stream.js`、Linux collector | deadline→有界 output→close／late-ready fence | SSH pool／stream／host-key 測試 | 審查＋fake／loopback 測試；真 SSH 設備 NOT RUN |
| 10. UGREEN NAS | `nas-login-singleflight.js`、token generation、request runner、`server.js` | token lease→read→invalid token retry→config fence | NAS token／login／request、P1 generation | P1-006 FIXED |
| 11. UPS／PPB | `ppb-client.js`、source selection／UPS state／event sync | source/fallback→healthy/degraded/offline/unknown→event init | PPB／UPS 測試、soak | 審查＋自動測試；實際 UPS 切換 NOT RUN |
| 12. WiiM | `wiim-client.js`、`pollWiimTemp`、art proxy | readonly single-flight→fresh/stale→history→reset | WiiM client／proxy／command、P1 generation | P1-006 FIXED |
| 13. AdGuard | client、service-policy／reconciler／routes | deadline／response cap→ownership→offline／recover | AdGuard client／policy／route | 審查＋自動測試；實際 policy recovery NOT RUN |
| 14. Docker／NAS Monitor | nas-monitor client／SSE／broker | allowlist→bounded request→event disconnect／recovery | nas-monitor／SSE／Docker state 測試 | 審查＋自動測試；本地 Docker BLOCKED |
| 15. SSE／collector cache | `sse-client-manager.js`、device collector cache、SSE upstream | shared upstream→bounded buffer→drain timeout→close | `sse-backpressure.test.js`、collector／soak | 審查＋自動測試 |
| 16. 通知／Web Push | notification delivery、web-push service、notification states | capped state→cooldown→bounded send/retry→abort | notification／web-push／state 測試 | 審查＋自動測試；第三方投遞 NOT RUN |
| 17. Telegram Bot | `telegram-command-bot.js`、server startup | allowed chat→long-poll→bounded retry→abort stop | `telegram-command-bot.test.js` | 審查＋自動測試；實際 Telegram NOT RUN |
| 18. Reports／Automation | `server/jobs/report-*`、`runSerialJob`、threat blocking／AdGuard policy | SQLite claim/lease/fencing→deadline→release/retry | report runner／schedule DB、threat／policy | 審查＋自動測試；不承諾第三方 exactly-once |
| 19. Frontend Lifecycle | frontend-lifecycle／action-dispatcher／bootstrap／app／PWA | hydration generation→page/hidden teardown→observer/SSE/Chart | frontend lifecycle／hydration／CSP／assets、soak | targeted 審查；真瀏覽器長 session NOT RUN |
| 20. Shutdown／Observability | `server.js shutdown`、health／tracker／resource samples | stop producers→close resources→DB flush→release lock→exit | production runtime smoke、instance／SSE／SSH、soak | 隔離測試；NAS Docker 20 秒驗收另列 |

## Confirmed P1 Findings

### P1-001 — 跨批次 rollup 覆蓋已彙整資料

- **Priority／Module：** P1／SQLite history 與 UniFi telemetry。
- **File／Line：** `db.js:508,1475–1575,1650–1706,1835–1865`（本次修復樹）。
- **Symptom：** 長期資料在多階彙整後 sample_count、平均數不正確，raw 已刪後無法重建。
- **Root Cause：** 每批 100 個 bucket 的 promotion 可以切開上一層完整 bucket；下一批 UPSERT 直接覆蓋 target，而上一批來源已在 transaction 刪除。讀取時 source priority 也會忽略尚未 promotion 的 disjoint raw／低階資料。
- **Impact／Reproduction：** 240 筆分鐘資料跨 4 小時，原版計數為 `[60,20,60,40]`，只剩 180；兩個 device 交錯亦重現。
- **Fix：** 在同一 transaction 讀取並合併既有 disjoint target 後再刪來源，sample_count 相加；read path 合併各階的 disjoint observations。
- **Regression Test：** `p1-history-integrity.test.js` 的跨批次、雙設備、late data、cleanup 重跑與 restart。
- **Status：** FIXED；基準 FAIL、修復 PASS。
- **Residual Risk：** 舊版本已刪掉的原始資訊不可逆；只有舊 rollup 時不能補回被覆蓋樣本。本修復不提供任意外部資料重送的全域去重保證。

### P1-002 — 巢狀遙測遺失，null 跨階加權錯誤

- **Priority／Module：** P1／歷史資料完整性。
- **File／Line：** `server/storage/history-aggregation.js:1–98`、`db.js` aggregate 呼叫。
- **Symptom：** UCG `cores` array、NAS `disks` object 被忽略；null 不直接當 0，卻被計入下階平均的樣本權重。
- **Root Cause：** 原 aggregator 只處理最上層 scalar，並以整桶 sample_count 代替每個欄位的有效樣本數。
- **Impact／Reproduction：** 1 筆 50、59 筆 null、60 筆 100 應為 99.1803，原版為 75；cores／disks 在 raw 聚合與 rollup 皆失去。
- **Fix：** 有深度上限的遞迴欄位聚合，持久化每欄 sufficient statistics；保留 null；counter 依實際最後觀測時間而非合併陣列順序。私有 `_smarthubRollup` 統計不進 API。
- **Regression Test：** nested／null／late counter／metadata 不外洩測試，30–365 天等量資料模擬。
- **Status：** FIXED；基準 FAIL、修復 PASS。
- **Residual Risk：** 舊 rollup 沒有每欄有效計數，只能保留既有數值並使用舊 sample_count 近似；不能宣稱歷史精度已回溯修復。CPU／JSON 統計成本上升，詳見量測。

### P1-003 — UniFi 舊設定請求污染新 session

- **Priority／Module：** P1／Controller config race。
- **File／Line：** `server.js:417–580,4073`。
- **Symptom／Root Cause：** 舊登入／回應完成後仍可更新全域 cookie、CSRF；舊 finally 可以清除新 in-flight。沒有 config generation 與 promise identity 檢查。
- **Impact／Reproduction：** A 登入未完即切 B，再依相反順序回覆，舊值可以取代 B；shutdown 中 late login 也不應恢復狀態。
- **Fix：** client／login capture generation；request、response、login commit 與 refresh 皆驗證；reset 先使舊世代失效；finally 只清除自身 promise；shutdown 拒絕。
- **Regression Test：** `p1-controller-session.test.js` config change／late response／shutdown，既有 auth retry。
- **Status：** FIXED；基準 FAIL、修復 PASS。
- **Residual Risk：** 本地 VM 測試執行 production auth assembly，但不等同特定 UniFi firmware 的 cookie／CSRF 實機驗證。

### P1-004 — 連續失敗與延遲 401 造成登入風暴

- **Priority／Module：** P1／Controller authentication recovery。
- **File／Line：** `server.js:449–467,489–580`。
- **Root Cause／Symptom：** single-flight 只合併同時存在的 promise，對已完成失敗後的新呼叫沒有退避；舊 session 延遲 401 每次再把新 cookie 作廢。
- **Impact／Reproduction：** 24 個延遲 401 造成 24 次額外 login；50 次連續 offline call 造成 50 次 login。
- **Fix：** session version 使舊 401 使用已更新的 session；login failure 採 1 秒起、最高 60 秒退避，成功／設定重建清除。沒有堆積 sleep promise、timer 或無限 retry。
- **Regression Test：** delayed 401、50 次 sequential offline、deadline 後恢復；保留原本 non-idempotent write retry 限制。
- **Status：** FIXED；24 次額外 login→1 次，離線立即連續 50 次→1 次。
- **Residual Risk：** 退避期間回報錯誤是刻意的上游保護；非「已恢復」假成功。真實 Controller 重啟仍待設備驗收。

### P1-005 — SQLite 持續寫入失敗造成無界緩衝

- **Priority／Module：** P1／Memory/resource。
- **File／Line：** `db.js:1730–1753`。
- **Root Cause／Symptom：** 原版先 append 再 flush，失敗時保留舊 queue；下一個 caller 仍 append，設定上限失效。
- **Impact／Reproduction：** 用 SQLite trigger 持續注入寫入錯誤，設定最多 4 筆仍可累積 500 筆。正常 sampler 遇到持續 SQLite 錯誤即可持續增加記憶體，不需惡意 workload。
- **Fix：** 在 admission 前以 count／bytes 檢查容量，必要 flush 失敗即拒絕新值；單點超限回 `HISTORY_POINT_TOO_LARGE`。保留已接收資料，不以丟舊資料偽裝修復。
- **Regression Test：** `p1-history-backpressure.test.js` 500 次故障、byte bound、移除故障後精確 flush recovery。
- **Status：** FIXED；4 筆上限故障測試，500→4。
- **Residual Risk：** DB 故障時拒絕新資料可能形成缺口，且緩衝尚未 flush 的資料不具 power-loss durability。這是明確 backpressure，不承諾故障時不遺失任何新觀測。

### P1-006 — WiiM／NAS config generation 只保護 cache，未保護 consumer

- **Priority／Module：** P1／Integration state/history race。
- **File／Line：** `wiim-client.js:128–165`、`nas-request-retry.js:13–68`、`server.js:3143`。
- **Root Cause／Symptom：** WiiM 雖不更新已失效 cache，卻仍把舊成功回應標成 live 回傳，consumer 可寫入新時間的歷史；NAS token fencing 不足以拒絕已取得 token 的舊 request 回應。
- **Impact／Reproduction：** 舊 WiiM 的 99 度不能寫成新設備目前值；舊 NAS response 不能推進新連線 health 成功或清新 token。
- **Fix：** WiiM 在 fallback 前與 response 返回前驗證 generation/IP，既有 typed result 回 `unreachable`、null、`configuration_changed`；NAS 在 token、request、validation 後驗證 client generation，read-only 最多 2 次重新取得新設定資料。
- **Regression Test：** `p1-integration-generation.test.js` 4 項，包含 production `pollWiimTemp`、禁止用新設定的 HTTP opt-in 重試舊設備、NAS 舊成功／錯誤不得污染 health／token。更新原 WiiM test 為更嚴格的 caller-facing freshness assertion。
- **Status：** FIXED；相關 21 項測試 PASS。
- **Residual Risk：** 設定短時間持續變更仍可能回 superseded error，屬安全拒絕；沒有增加 TLS bypass，也沒有讓 mutation 無條件重試。

### P1-007 — Cleanup 首次同步失敗後 worker 永久失效

- **Priority／Module：** P1／SQLite maintenance worker。
- **File／Line：** `db.js:2575–2667`。
- **Root Cause：** `inflight = (async () => {... finally { inflight = null; }})()` 在首個 await 前同步失敗時，finally 先清空，外層賦值才把 rejected Promise 永久放回 inflight。
- **Impact／Reproduction：** rollup transaction 故障後 raw 正確 rollback，但即使移除故障，後續 cleanup 都重用 rejected Promise，retention／rollup 無法恢復。
- **Fix：** 以 `Promise.resolve().then(async () => ...)` 先安裝 owner promise 再執行工作，finally 才可正確解除；不加 arbitrary sleep。
- **Regression Test：** `p1-sqlite-recovery.test.js` 注入 rollup insert abort→確認 raw 仍 120→移除 trigger→cleanup 恢復→120 筆計數→再次執行不重複。
- **Status：** FIXED；首次測試重現 FAIL，修復後 PASS。
- **Residual Risk：** 永久磁碟故障無法靠 worker 自動修復；需告警與維修，但不再因一次暫時錯誤永久失效。

## Fixes 與相容性

沒有 SQL schema migration、刪表或正式 DB 操作。統計存於既有 rollup JSON，可讀舊格式；API 不新增私有統計欄位。WiiM 沿用 `unreachable` 既有型別，NAS runner 新注入項有 backward-compatible default；沒有新 endpoint，`server-mock.js` 外部契約不需變更。

CSS 環境差異已查明並隔離全域 NODE_PATH；最終保留原版 CSS，未變更 frontend source 或 UI class。沒有增加部署記憶體上限、調長 timeout、修改輪詢設定或放寬 TLS。新增 history aggregator 同步 backend map；報告同步 docs 與 HTML 文件索引。

## Regression Tests 與可靠性故障注入

| 測試檔 | 新增項數 | 主要斷言 |
|---|---:|---|
| `p1-history-integrity.test.js` | 5 | 跨 batch／雙 device／nested／null／late counter／restart |
| `p1-controller-session.test.js` | 5 | config race、stale 401、offline backoff、恢復、shutdown |
| `p1-history-backpressure.test.js` | 2 | count／bytes cap、持續錯誤與 recovery |
| `p1-integration-generation.test.js` | 4 | 舊 WiiM 不入庫、舊 HTTP fallback 不執行、NAS 舊成功／錯誤 |
| `p1-sqlite-recovery.test.js` | 2 | transaction rollback＋retry、SIGKILL 後 WAL＋restart |
| 合計 | 18 | 基準／修復樹分離，沒有測正式 DATA_DIR |

原始 SQL trigger 注入的是 deterministic transaction failure，不冒充真實 `ENOSPC`／硬碟損毀測試。SIGKILL child 在 flush 後被終止，20 筆 committed data 經 WAL recovery／checkpoint／二次 restart 仍精確保留；不把此結果推論成物理斷電 durability。

### Integration failure matrix 的證據邊界

既有完整 suite 包含：UniFi 401／403 與寫入 retry policy；PPB auth／generation／TLS policy；NAS 401／500、token rejected／權限拒絕／舊 token；Site Manager 429 與 timeout／pagination bounds；AdGuard timeout／invalid／oversized response；WiiM offline／invalid／oversized／HTTPS 與明確 opt-in fallback；SSH deadline／output cap／close／host key；SSE drain timeout／disconnect；notification bounded send／retry；report claim／deadline／restart。

**未逐一對每個整合執行全部 14 種故障。** 真實 DNS failure、TLS appliance certificate rotation、connection reset 在所有韌體上的恢復、實際第三方 429、NAS reboot 中的 request、Docker daemon restart 與 shutdown during request 的全交叉組合，仍屬 NOT RUN。單一 owner 的 fake 測試不能代替其他 owner 或實機的驗收。

## Memory / Resource Lifecycle

資源 construct 搜尋涵蓋 `server.js`、`db.js`、`activity-lease.js`、`telegram-command-bot.js`、`server/`、`observability/`、`public/js/`，本次 inventory 455 個命中；此數量是搜尋命中，不是 455 個 leak 或逐行完整審查證明。

| 資源 | Capacity／TTL／Cleanup／Shutdown |
|---|---|
| Activity sessions | 1,000 sessions、每 session 最多 8 scopes；sequence／expiry／LRU；expired session 不加速 sampler |
| SQLite pending history | 預設 1,000 points／1 MiB；修復後失敗 admission 仍受上限；flush 成功釋放，close flush 失敗不得假稱成功 |
| Device collector cache | 500 entries／8 MiB／30 分鐘 TTL；設定 prefix invalidation；實際 keys 與 upstream deadline 另有約束 |
| SSE clients | 最多 100，per-client writable buffer 256 KiB，drain timeout 10 秒；close 清 listener／timer；shared upstream 非每 client 一條設備連線 |
| SSH | command deadline 12 秒、stdout/stderr 1 MiB；Device thermal 更小 128 KiB、最多同時 2 個工作；close settle queued/pending，late ready 不復活 |
| WiiM readonly cache | 命令集合有界，fresh 2 秒／stale 5 分鐘；reset 清 cache/in-flight，舊回應現在也不回 live |
| UniFi login | 單一 login／refresh promise、identity cleanup；失敗退避不持有 sleeping queue／timer；世代與 shutdown fence |
| Notification／reports | bounded watcher state／cooldown、Web Push worker concurrency／deadline、SQLite claim lease／retry；沒有宣稱第三方投遞 exactly-once |
| Observability | resource sample／recent-task store 有界；本次 probe 也有 frame 上限且不在 production startup 自動載入 |

長期集合的第三方內部資源、OS socket、native memory、每一個 frontend plugin 的持有關係未做 heap snapshot dominator 分析。本次確認的是特定 SQLite buffer failure leak；**不能依單次 RSS 或 90 秒沒有上升就宣稱全程無 memory leak**。

## Scheduler / Polling

實際 `device-sampling-policy.js` 預設：一般設備 active 5 秒／idle 600 秒；UPS 3／10 秒；PPB events 10／60 秒；UniFi telemetry 60／300 秒。設定可覆寫；本次未改 interval。

Adaptive sampler 僅在前次 collect settle 後安排下一輪；registry 只重排命中 scope；`runSerialJob` 以同名執行集合防重入，finally 清除。P1-007 是 maintenance Promise owner 的實際例外，已修。

Activity lease 的 duplicate／out-of-order、expiry、tab isolation 由現有 tests 重驗。共享 snapshot GET 對 UPS、UniFi device telemetry、public health 的 call chain 不增加設備 I/O；本次 Controller storm 實測不是宣稱 N 個真實使用者的所有 API 都已壓測。真實多使用者 heavy-history query amplification、長時間 browser polling 仍需 staging 壓測。

## SQLite

Raw→rollup 的資料搬移與來源刪除在同一 transaction；新 merge 避免 split-batch overwrite。cleanup 的 batch／yield 與完整 bucket 規則保留，沒有一次刪除未處理資料來縮短時間。私有統計保留 numeric-valid count、最後 counter timestamp；null 不當 0。UTC bucket／timestamp boundary 的既有測試與新 late-arrival 測試一同執行。

`busy_timeout=5000`、WAL／NORMAL 與 checkpoint policy 沿用原設計。合成測試中 WAL 峰值約 4.16 MiB，TRUNCATE checkpoint 後為 0；這只證明本測試的 bounded reader/write workload。**外部長讀取、長 backup、磁碟滿、檔案系統錯誤可阻止 checkpoint，沒有證據可保證這些情境 WAL 永遠受此數字限制。**

重啟測試涵蓋 committed data、WAL、重複 cleanup；不承諾任意重送事件跨聚合後的無限期 dedup，亦不承諾 buffered unflushed data 抗停電。

## Integrations

UniFi session 的 configuration／authentication generation 各有責任邊界；舊 401 不再每次重新登入。NAS client generation 與 token lease 分開檢查，最多 2 次 read-only retry；權限拒絕不以登入重試掩蓋。WiiM 嚴格 freshness 延伸到 caller，不只保護 cache。

UPS 保留 healthy／degraded／offline／unknown，lastKnown 不被當作現在 healthy；明確 source 仍 fail-closed，PPB event 首次同步不補發所有歷史通知。其他整合保留 timeout、response cap、TLS／proxy policy、read/write retry 邊界，未做與 P1 無關的大型 refactor。

## Notifications

通知服務離線的 bounded send、deadline、cooldown、report claim／lease 重試由相關 tests 重驗。Web Push 仍是額外 fan-out，訂閱／recent state capacity 與原設計一致。未呼叫真實 Telegram／Discord／Webhook／Push endpoint；沒有 exactly-once 第三方投遞承諾。failure 後 retry 可能重複 delivery，應以既有 dedup／cooldown 管理，而非宣告網路不可達時仍成功。

## Frontend Lifecycle

重點追蹤 hydration generation、快速切頁、hidden／visible、pagehide、SSE close、MutationObserver disconnect、Chart instance 的 lazy initialization／更新與 teardown、action dispatcher 單次註冊、Service Worker 不快取 API。沒有確認新的 High 等級 frontend leak，因此本 PR 不擴大重構 UI。

測試是 Node fake lifecycle／contract 與短 soak，**沒有真實瀏覽器 24 小時 session、Chart heap snapshot、全部分頁／network reconnect 手動驗收**。一般 UX、小型效能與尚無證據的 leak 推論不升級 P1。

## Shutdown / Restart

追蹤 startup→instance lock→samplers/report/notification→listen；shutdown 先停止新工作，停止 timer／bot／sampler，關 SSE／SSH／agents，settle tracked tasks，flush/checkpoint SQLite，釋放 instance lock。現有 app graceful timeout 與 Compose `stop_grace_period: 20s` 未增加。

P1 controller test 明確拒絕 shutdown 後 late login；WAL crash test 只測隔離 child。production smoke 的實測重啟與 graceful stop 結果列於下方，Hosted Docker smoke 的結果以 exact-head gate 為準。本地 process smoke 不等於 NAS Docker stop/reboot。

## Performance Before / After

### 同條件 before／after

Node 24.18.0、Linux x64，同一隔離環境；before 為 exact-base worktree，after 為修復 source。合成案例依 30／90／180／365 天順序執行，各用全新 SQLite，保留相同 retention 365 天／cap 1,000,000／每分鐘 1 筆。短 soak 兩輪先後執行，沒有同時進行重型合成測試。未作多次分布／統計顯著性推論。

| Metric | Before | After | Difference／Evidence |
|---|---:|---:|---|
| 240 筆跨 batch 樣本計數 | 180 | 240 | 不再遺失 60 筆計數；P1-001 |
| 500 次故障、設定 4 筆 buffer | 500 | 4 | −496；P1-005 |
| 24 個延遲 401 的額外 login | 24 | 1 | −23；P1-004 |
| 50 次立即連續離線 login 呼叫 | 50 | 1 | −49；有界 backoff，不是永不重試 |
| 有效值平均，夾 59 筆 null | 75 | 99.1803 | 正確有效 count；P1-002 |

### 30／90／180／365 天等量資料模擬

| 等量天數／輸入筆數 | 保留樣本 Before → After | Cleanup 秒 Before → After | Query 中位 ms Before → After | DB MiB Before → After |
|---|---|---|---|---|
| 30／43,200 | 43,200 → 43,200 | 1.554 → 2.324 | 46.013 → 189.742 | 6.762 → 9.730 |
| 90／129,600 | 112,320 → 129,600 | 10.818 → 13.298 | 23.533 → 114.680 | 21.699 → 21.738 |
| 180／259,200 | 216,000 → 259,200 | 40.601 → 46.120 | 33.301 → 160.785 | 44.156 → 44.195 |
| 365／525,600 | 429,120 → 525,600 | 165.326 → 175.799 | 67.150 → 246.983 | 91.027 → 91.066 |

Query 為 5 次讀取的中位數、pointBudget 240。Before 少做了巢狀欄位與正確 per-field 統計，因此這是**同輸入的實測成本比較，不是功能等價的速度勝負**。365 天案例增加約 10.473 秒 cleanup 與 179.833 ms query 中位數；不隱藏 regression，也不以少保留資料換取快。cleanup 分批 yield，不等於整段 175.799 秒連續阻塞 event loop。

| 365 天資源 | Before | After | 證據 |
|---|---:|---:|---|
| 取樣 RSS 峰值 MiB | 286.656 | 326.867 | synthetic JSON |
| 取樣 Heap 峰值 MiB | 91.491 | 104.917 | synthetic JSON |
| WAL 峰值 MiB | 4.161 | 4.161 | synthetic JSON |
| checkpoint 後 WAL bytes | 0.000 | 0.000 | TRUNCATE |
| Event loop p99 ms | 69.272 | 72.417 | monitorEventLoopDelay |
| Event loop max ms | 98.238 | 266.994 | monitorEventLoopDelay |

四個修復案例均 sample conservation／nested fields／restart equality／SQLite quick_check 通過，重複 cleanup 不產生新 rollup。Post-GC、CPU、其他時間點與 DB/WAL bytes 保存在 JSON；合成 benchmark 不是實際 soak。

### 真實經過時間的 90 秒 lifecycle soak

| Metric | Before | After | Evidence |
|---|---:|---:|---|
| Soak duration ms | 90081.000 | 90087.000 | runtime-soak 實測 |
| RSS startup MiB | 40.762 | 40.668 | preload、載入模組前 |
| RSS warm-up（第 10 秒）MiB | 71.848 | 71.871 | resource probe |
| RSS steady sample（第 45 秒）MiB | 75.109 | 75.012 | 不是長期 steady-state 證明 |
| RSS observed peak MiB | 77.020 | 77.297 | 包括 recovery／post-GC |
| Heap used peak MiB | 10.985 | 11.271 | 1 秒取樣，不是所有瞬間最大值 |
| Heap total peak MiB | 17.363 | 16.863 | resource probe |
| External peak MiB | 4.103 | 4.103 | resource probe |
| Heap post-GC MiB | 6.597 | 6.628 | --expose-gc |
| CPU user+system 秒 | 1.272 | 1.286 | process.cpuUsage 累計 |
| Event loop p99 ms | 10.584 | 10.584 | monitorEventLoopDelay |
| Event loop max ms | 24.166 | 28.492 | monitorEventLoopDelay |
| Final active handles／requests | 0.000 | 0.000 | probe與unexpected resources斷言 |
| Final timers／SSE／sessions／running collectors | 0.000 | 0.000 | runtime-soak |
| Collector cache peak entries | 64.000 | 64.000 | 壓力測試 capacity=64，非 production default |
| Collector cache final entries／bytes | 0.000 | 0.000 | clear後 |
| Unhandled rejection／uncaught exception | 0.000 | 0.000 | runtime-soak |

RSS 約 +0.28 MiB、post-GC heap 約 +0.03 MiB，不據此聲稱改善或存在新的 leak。短 soak 使用 fake browser／sampler／SSE 資源，不是真實 authenticated 使用者流量；SSH 真連線與 container restart 在此情境為 NOT RUN，不能把沒有建立的連線說成已驗證回收。相同條件之外的 NAS 實體 RAM／CPU 數字為 NOT COMPARABLE。

### 可重現命令與機器證據

```bash
node --expose-gc scripts/p1-reliability-evidence.js --days=30,90,180,365
P1_RESOURCE_FILE=/tmp/p1-resource.json SOAK_TEST_DURATION_MS=90000 SOAK_TEST_TICK_MS=20 \
  node --expose-gc --require ./scripts/p1-resource-probe.js scripts/runtime-soak.js
```

測試自行建立全新 temporary DB，沒有接受 production data directory 的選項。before 可設定 `P1_AUDIT_SOURCE_ROOT` 指向獨立 baseline worktree，並加 `--observe-only` 收集已知錯誤而不假裝通過。

- [local-validation.json](evidence/p1-reliability-20260918/local-validation.json)
- [synthetic-before.json](evidence/p1-reliability-20260918/synthetic-before.json)
- [synthetic-after.json](evidence/p1-reliability-20260918/synthetic-after.json)
- [soak-before-resource.json](evidence/p1-reliability-20260918/soak-before-resource.json)
- [soak-after-resource.json](evidence/p1-reliability-20260918/soak-after-resource.json)


## Test Results

| Test | Result | Evidence |
|---|---|---|
| 隔離 Actions `npm ci` | PASS | Bootstrap run 35314924234，exact-base checkout，locked dependencies |
| 基準 `npm test`（非 root、隔離全域 NODE_PATH） | PASS | 755 total／755 pass／0 fail；32,578.443 ms。初次全域 autoprefixer 造成的 CSS 假性失敗另保留 |
| 新回歸在基準／修復前 | FAIL | history 5、auth 5、buffer 2、generation 4 都重現；rollback test 另重現 maintenance 永久失敗 |
| 修復 `npm test` | PASS | **773 total／773 pass／0 fail／0 cancelled／0 skipped，32,742.379 ms** |
| `npm run check:js` | PASS | Node 24.18.0，本次修復 source 全部 syntax check |
| `npm run check:css` | PASS | 清空 NODE_PATH 後，既有 build 與原版 CSS 一致；未刪除 prefix／未放寬 gate |
| `npm run test:smoke` | PASS | health/ready/login 200、readonly write／missing CSRF 403；兩次 SIGTERM exit 0，在 smoke 12 秒 deadline 內；restart persistence PASS |
| `npm run test:soak` 同一腳本＋資源 preload | PASS | before 90,081 ms／after 90,087 ms，cleanup assertions 無殘留 |
| 四個等量 synthetic SQLite 案例 | PASS | 修復 30／90／180／365 天 sample／nested／restart／quick_check；原版已知 loss 清楚保留 |
| SQLite rollback／WAL crash recovery | PASS | SQL trigger／SIGKILL 的全新 temporary DB，不是正式磁碟故障 |
| 文件契約、`git diff --check` | PASS | 交付前另重驗；沒有 whitespace errors |
| 本地 `npm audit --audit-level=low` | BLOCKED | registry DNS 不可用；Hosted audit 結果另以 run／PR 記錄 |
| 本地 Compose／Docker | BLOCKED | 工具不存在；Hosted exact-head gate 驗證另記 |
| Latest-head SmartHub CI／Repository gate | 由交付時 PR 記錄 | 未以 bootstrap 冒充；只能採最新 HEAD 的 result／pending 狀態 |

`local-validation.json` 保存測試摘要與被測 source SHA256；完整 local stdout 留在交付證據檔，不提交 raw logs。Hosted check 的 audit／build／smoke／scan 結果不能由本地 tests 推定。


### 交付前重驗補充

最後一次隔離全域 `NODE_PATH` 的完整測試為 773／773 PASS（32,742.379 ms），baseline 為 755／755 PASS（32,578.443 ms）。新增的是既有 telemetry 回歸測試的 timestamp assertions，回歸測試數仍為 18。數據檔保留各次量測當時的 source SHA256：synthetic／90 秒 soak 在最後兩處 UniFi telemetry timestamp 傳遞修正前執行，不能冒稱量測了最終 commit；該兩處不在單 series trend benchmark 或 sampler/SSE soak 呼叫鏈，最終 telemetry 路徑另以回歸及完整測試驗證。最終完整測試的 source hashes 另見 `local-validation.json`。

Hosted 依賴稽核證據：delivery diagnostic run `35318294910` 的 `npm audit --audit-level=low --json` 為零漏洞（282 dependencies）。該 workflow 整體因當時的 CSS 雜湊診斷失敗，不能稱整個 workflow PASS；正式 SmartHub CI 仍需依最新 PR HEAD 驗證。

## Independent Diff Review

第二輪檢查涵蓋：跨階 disjoint data 是否重複／遺漏、counter 時序、private metadata 是否洩漏 API、null／nested、failed transaction rollback、Promise assignment race、old-generation 回應、login storm、bounded retry、write retry policy、buffer admission／recovery、shutdown callbacks、mock contract、Docker／TLS／polling interval 是否被改動。

新增 rollback test 在第二輪確認 P1-007，修復並重跑相關測試。原 WiiM test 改為更嚴格的 caller freshness，沒有刪除失敗 assertion。公開 API 不增加欄位，不需假造 mock 欄位。另以擴充既有 telemetry 測試確認混合 raw／rollup 讀取與 promotion 都必須傳遞實際 timestamp；補齊 SQL alias 及 read-path timestamp 後，晚到的新 counter 不再被舊 rollup 蓋掉。修復前 59、修復後 5000，cleanup 前後皆驗證。CSS 輸出差異確定是本地全域 autoprefixer 污染，最終已撤去 CSS diff。Git 提交排除 `.env`、DB、logs、node_modules、暫存測試資料；branch-only transport 工作流程會從最終 net diff 移除。

## NOT RUN / BLOCKED

| 項目 | 結果 | 原因／不能替代的證據 |
|---|---|---|
| 真實 UniFi／UGREEN NAS／UPS／WiiM／AdGuard／Linux SSH／Docker socket | NOT RUN | 無真實設備網路驗收；未操作正式系統 |
| 真實第三方通知與 delivery exactly-once | NOT RUN | 沒有外部實際投遞；exactly-once 不作承諾 |
| 30 分鐘連續 soak | NOT RUN | 本次為明確的 90 秒短 soak；合成資料處理耗時不是 soak |
| 24h soak | NOT RUN | 未實際持續運行 24 小時 |
| 72h soak | NOT RUN | 未實際持續運行 72 小時 |
| 真實 NAS reboot／停電／RAID 或磁碟滿／所有整合 DNS/TLS reset 矩陣 | NOT RUN | deterministic fake、SIGKILL、loopback 不能替代 |
| 真瀏覽器長 session／多使用者完整負載／heap dominator 分析 | NOT RUN | lifecycle primitive／contract／短 soak 不代表實機完整測試 |
| 本地 Docker build／Compose config | BLOCKED | Docker／Compose 不存在；Hosted gate 的結果另記 |
| 本地 npm registry audit／原生 GitHub fetch/push | BLOCKED | DNS／network；改由 connected GitHub／隔離 Actions 安全執行，不當作本地 PASS |

## Residual Risks

1. 舊版本已遺失的 rollup 原始資料與欄位統計不可自動復原；部署前保留一致性備份，不能把本修復當作歷史資料重建。
2. 正確聚合增加 CPU／JSON 欄位與 query latency；本次 365 天等量資料為單 series／1 分鐘 cadence，不是多設備 3 秒採樣的上界。較慢 NAS 與多使用者需要 staging performance acceptance。
3. 持續 DB 故障下採 backpressure 拒絕新樣本，可能有觀測缺口；不能用 RAM 無界保留假裝資料可用。WAL 長 reader／backup／disk pressure 需監控。
4. 真實 Controller session／NAS JWT／PPB firmware／device SSH 行為仍待現場驗收。UNCONFIRMED 的理論 race／資源疑慮不能當已修或未修 P1 計數。
5. 外部投遞無 exactly-once；report persistence 和 cooldown 測試不能保證對端已收到，也不能完全消除 crash 時重送。
6. 90 秒資源穩定不代表數週 native memory／listener 無 leak。無實際 24h／72h 證據前，不應宣告 NAS 24/7 生產驗收完成。

## Deployment Impact / Rollback

本次未部署。由維護者在 Draft PR 審核與 staging 驗收後決定是否合併；本任務沒有 merge 或 auto-merge。新版本可讀舊資料；新增統計在既有 JSON，不需 DDL migration。回退 image 不應刪 Volume 或覆蓋正式設定。舊程式可能不保留新統計，回退也不能復原舊版已丟失資料；回退前留存一致性 DB 備份，並重新驗證 history／retention。

## Final P1 Status

**本次已確認 P1：7；已修復：7；已確認但未修復：0。** 這不代表完整生產接受條件已完成。以最新 PR HEAD 的 `SmartHub CI / Repository gate` 作 Hosted 驗證依據，不以 bootstrap 或歷史 green run 代替；CI 的完整 SHA、URL、conclusion 由交付時 PR comment／最終回覆記錄。真實設備與 24h／72h soak 仍 NOT RUN，PR 保持 Draft。
