# SmartHub Production Hardening Progress

> 本文件是 Production Final Engineering Review 的持續恢復點。每個重要發現、修復、測試與 commit 均應在當下更新，不能只依賴對話紀錄。

## 任務開始狀態

- 開始時間：2026-07-14T11:48:00+08:00（Asia/Taipei）
- 初始正式分支：`main`
- 初始 commit：`c6d728d618a0cb9cc31668fb0a4428fa5977a62e`（`merge: stabilize WiiM playback progress`）
- 工作分支：`codex/production-final-hardening`
- 執行環境：macOS、Node `v26.4.0`、npm `11.17.0`、Docker `29.4.0`、Docker Compose `v5.1.2`
- 初始工作樹：`public/index.html` 已有 32 行差異（25 additions / 7 deletions），屬任務開始前既有使用者修改；本次工作必須保留、隔離辨識，不可誤覆蓋或假稱為 hardening 修復。
- 初始 ignore 檢查：`.env`、`data/`、`node_modules/`、`*.log`、`.DS_Store` 均被 `.gitignore` 排除；初始 `git ls-files` 未發現上述 runtime/secret 路徑被追蹤。

## 系統架構摘要（持續補充）

- Runtime：Node.js + Express 單一 process；正式入口 `server.js`，開發假資料入口 `server-mock.js`。
- Frontend：`public/index.html` 單檔 SPA，透過 HTTP API 與 SSE 取得資料。
- Database：`better-sqlite3` 單連線、WAL；歷史、事件與報表紀錄位於具名 volume 中的 `data/smarthub.db`。
- Background work：同 process 週期排程；`runSerialJob()` / task tracker 防止同名工作重入，無外部 queue broker。
- External integrations：UniFi local/cloud、UCG/Linux SSH、UGREEN NAS、NAS Monitor、WiiM、UPS PPB/NUT 等來源、AdGuard；皆應在失敗時隔離，不可拖垮主服務。
- Observability：structured logger、issue/task tracker、system monitor；`/health` 為 liveness、`/health/ready` 驗證 SQLite/worker、`/api/system/status` 提供受驗證完整診斷。
- Production lifecycle：Docker 單服務、tini PID 1、非 root node user、具名資料 volume、`.env` bind mount、restart policy 與 healthcheck。

## 已辨識的重要模組

| 模組 | 主要檔案 | 審查重點 |
|---|---|---|
| HTTP / integrations / scheduling | `server.js` | request flow、timeout/retry、排程重疊、錯誤隔離、shutdown |
| SQLite lifecycle | `db.js` | migration、transaction、buffer flush、retention、WAL、close/restart |
| Activity lease | `activity-lease.js` | 活動 scope、租約過期、排程頻率 |
| NAS log forwarding | `nas-log-forwarder.js` | baseline、重複事件、通知與 cursor |
| Observability | `observability/*.js` | bounded state、health semantics、stuck detection、secret masking |
| SPA / polling / charts | `public/index.html` | API contract、overlap、timer/listener/chart lifecycle、failure UI、XSS |
| Development parity | `server-mock.js` | frontend-visible endpoint/settings parity |
| Container / deployment | `Dockerfile`, `docker-compose.yml`, `.dockerignore` | reproducibility、signal、readiness、permissions、persistence、build context |
| Tests | `test/*.test.js` | critical/failure/concurrency/regression coverage |

## 30 / 90 / 365 天初始風險假設

以下是假設，必須以程式碼、測試與量測驗證，不得直接當作結論：

- 30 天：高頻輪詢與外部 timeout 可能造成重疊、log storm、SQLite 寫入壓力或 UI stale state。
- 90 天：歷史/事件/報表 retention 或 in-memory cache 若缺少上限，可能造成 DB、WAL、RSS 持續成長。
- 365 天：排程日期/時區、清理/vacuum、restart 後重複 side effect、設定/資料備份一致性可能成為主要失效點。
- 任意時間：外部設備長時間失聯、malformed payload、DNS/TLS/401/429、SQLite busy/corruption、SIGTERM 中途 flush，以及 Docker memory limit 下同步查詢阻塞，均需有可觀察且可恢復的行為。

## 初始風險與文件落差

- `SERVER-MAP.md` 與 `FRONTEND-MAP.md` 的行數估計已落後目前 checkout（實際約 3831 / 8767 行），索引行號可能漂移，稽核時必須重新以符號定位。
- `README.md` 與 `.env.example` 的 UPS 建議仍偏向 `nut` / `auto`，但目前專案工作規則記載 Docker 已驗證路徑為 PPB REST（`UPS_SOURCE=ppb`、`host.docker.internal:3052`）；需依 live implementation 與 runtime 證據收斂部署文件。
- package scripts 目前只有 `start` / `test`；是否存在 lint、typecheck、build gate 必須依實際技術棧判定並記錄「不存在」而非假稱通過。
- 尚無 `.github/` CI 或獨立 migration/schema 檔案；migration 可能內嵌於 `db.js`，需要精準審查。

## Audit Checklist

- [x] 保存初始 Git branch / commit / dirty tree
- [x] 建立獨立工作分支
- [x] 驗證基本 ignore 與敏感/runtime 檔案追蹤狀態
- [ ] 建立完整 architecture / request / data / lifecycle model
- [ ] 建立修改前 baseline 與 warning 分類
- [ ] Correctness / boundary / state transition audit
- [ ] Concurrency / scheduler overlap / duplicate side effect audit
- [ ] Memory / CPU / active handle / timer / cache audit
- [ ] SQLite query / migration / retention / unavailable behavior audit
- [ ] External API timeout / retry / malformed / rate-limit audit
- [ ] Docker / SIGTERM / restart / volume / permissions audit
- [ ] Security / dependency / auth / injection / secret audit
- [ ] Observability / log volume / root-cause usefulness audit
- [ ] Frontend UI / polling / failure / contract / console audit
- [ ] 主動建立 regression / failure / concurrency tests
- [ ] Failure injection
- [ ] Performance baseline / hot-path / soak trend
- [ ] Full regression gate
- [ ] Production release rehearsal
- [ ] Final adversarial review
- [ ] `PRODUCTION_READINESS_REPORT.md`
- [ ] Git status clean and all changes committed

## 當前執行階段

Phase 1 — Git isolation、恢復點與 architecture discovery。三個只讀稽核並行進行，主執行者建立 baseline 與系統生命週期模型。

## 已完成工作

1. 完整閱讀使用者提供的 Production Hardening 計畫。
2. 讀取 `AGENTS.md`、`CONTEXT.md`、`SERVER-MAP.md`、`FRONTEND-MAP.md`、`OBSERVABILITY.md`、`README.md`、`CLAUDE.md` 與主要 manifest/container/env 範例。
3. 保存基準並建立 `codex/production-final-hardening` 分支。
4. 確認既有未提交 UI 修改並留下隔離紀錄。
5. 確認 lockfile v3、130 個 package entries；尚未做 dependency install/audit。

## 發現問題 / Root Cause / 修復方式 / 修改檔案

目前仍在 discovery；尚未宣告任何未經 live tree 與測試證實的程式問題。

| Severity | 問題 | Root Cause | Production 影響 | 修復 / 修改檔案 | 驗證 |
|---|---|---|---|---|---|
| 待分類 | 部署與索引文件部分資訊疑似漂移 | 功能演進後文件未同步 | 可能導致錯誤部署或稽核漏讀 | 待 live implementation/runtime 驗證後更新 | 待執行 |

## 測試紀錄

| 階段 | Command | Exit | 結果 / Warning 分類 | 時間 |
|---|---|---:|---|---|
| Environment | `node --version` | 0 | `v26.4.0`；正式 image 為 Node 20，之後需在 Docker 內再驗證 | <1s |
| Environment | `npm --version` | 0 | `11.17.0` | <1s |
| Environment | `docker --version` | 0 | `29.4.0` | <1s |
| Environment | `docker compose version` | 0 | `v5.1.2` | <1s |
| Repository hygiene | `git check-ignore ...` / `git ls-files ...` | 0 | runtime、secret 與 cache pattern 正確排除；未發現被追蹤項目 | <1s |

## 尚未驗證項目

- npm clean install、test、syntax/static checks、dependency audit。
- Docker daemon/runtime 可用性、compose config/build/start/health/readiness。
- 所有 request/data/startup/shutdown/job/DB lifecycle 細節。
- 實際外部整合 failure isolation、UI browser flows、console 與 responsive behavior。
- restart/persistence、failure injection、效能/soak、final regression/rehearsal。

## 下一步工作

1. 盤點 entry points、startup/shutdown、routes/jobs/timers/DB schema 與 data flow。
2. 在不修改程式碼的狀態執行 baseline，完整保留 exit code、duration 與 warnings。
3. 整合並行稽核結果，以可重現證據排序修復批次。

## Commit Timeline

| Commit | Message | 驗證 |
|---|---|---|
| 待建立 | `docs: initialize production hardening audit trail` | Git hygiene / progress content review |

## 已知剩餘風險

除初始 Git/ignore 與文件盤點外，尚未完成任何 production readiness gate；目前版本不得因本文件存在而判定 READY。
