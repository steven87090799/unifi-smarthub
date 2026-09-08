# SmartHub AI／Claude Code 低上下文工作入口

本檔是本 repository 的唯一 AI 初始入口。先讀本檔，再讀 `CONTEXT.md`；不要因為看見連結就把整個 `docs/`、`server/` 或 `public/` 送進上下文。下面的連結是定位索引，不是自動匯入指令。

## 0. 強制邊界

- 先確認目前工作目錄與 `git status --short --branch`；保留使用者既有修改，不重設、不覆蓋、不刪除。
- 先分類任務，再只選一條讀取路徑。除非任務是全域發布／架構稽核，不要同時讀後端 map、前端 map、整份 README、operations 與 reports。
- 優先順序是：目前 source／tests → 對應 reference map → 對應 operations／integration 文件 → 歷史 report。報告不取代目前程式。
- `server.js`、`public/index.html`、`server-mock.js`、`db.js`、`observability/`、`data/`、`.env`、`node_modules/`、`package-lock.json` 預設不整檔讀取。
- 先用 `rg -n` 找 symbol、route、section、測試或錯誤，再用 `sed -n '起,迄p'` 讀最小必要區段；不要用 `cat` 或一次輸出大型檔案。
- 不讀取或回印 secret：`.env`、`config/`、`data/`、token、password、API key、cookie、完整 CA／SSH fingerprint。需要確認設定時只看 `.env.example` 或欄位是否存在。
- 修改前端可見 API／設定時，必須一起檢查 production、`server-mock.js` 與對應契約測試；不要只改 UI。
- 歷史資料權威是 `db.js`／SQLite；不要恢復整檔 JSON 寫入，也不要為了測試碰正式 `data/`。

## 1. 每個任務的最小讀取流程

1. 讀本檔與 `CONTEXT.md`，記下任務類型和預期變更檔案。
2. 讀下表中「只需要先讀」的單一索引；若任務跨區塊，才增加第二份索引。
3. 用搜尋錨點鎖定 owner、呼叫者與測試；只讀相關函式前後文，不讀整檔。
4. 修改前確認 `git diff` 沒有與任務無關的內容；修改後只驗證受影響範圍。
5. 若是發布／高風險變更，才依 `docs/operations/PRODUCTION-RELEASE-CHECKLIST.md` 執行完整 gate；一般文件或單模組修改不跑整套 Docker／soak。
6. 回報時分開：文件／source 變更、local checks、Hosted CI exact head、真實設備／NAS acceptance；未執行就是 `NOT RUN`。

## 2. 任務分流表：先讀哪裡、接著讀哪裡

| 任務 | 必先讀 | 之後只精讀 |
|---|---|---|
| 一般定位／文件 | `CONTEXT.md` | 目標文件與 `rg` 命中的 source／test |
| 後端 API／路由／安全 | `docs/reference/backend-map.md` | `server.js` 對應 route 區段、`server/routes/`、`server/policies/`、對應 test |
| SQLite／歷史／備份 | `docs/reference/backend-map.md` | `db.js` 命中的函式、`server/storage/`、`server/services/config-backup.js`、DB／backup test |
| 排程／輪詢／取樣 | `docs/reference/backend-map.md` | `activity-lease.js`、`backend-sampler-registry.js`、`adaptive-sampler.js`、對應 `server/jobs/`／test |
| UI／頁面／圖表／PWA | `docs/reference/frontend-map.md` | `public/index.html` 目標 `section`、`public/js/app.js` 目標函式、獨立 asset、frontend test |
| 前端 API／設定契約 | `docs/reference/frontend-map.md` | production route、`server-mock.js` 對應 route、`test/frontend-*` 或 contract test |
| UniFi／NAS／WiiM／UPS／AdGuard | `docs/reference/backend-map.md` | 對應 `docs/integrations/*.md`、client／policy／service、route、test |
| health／log／診斷 | `docs/operations/OBSERVABILITY.md` | `observability/health-routes.js`、logger／tracker／monitor、相關 test |
| Docker／GHCR／NAS 更新 | `README.md`、`docs/operations/PRODUCTION-RELEASE-CHECKLIST.md` | `docker-compose.yml`、build overlay、Dockerfile、`scripts/update-nas.sh`、workflow、deployment test |
| CI／release identity／依賴安全 | `README.md`、`docs/operations/PRODUCTION-RELEASE-CHECKLIST.md` | `.github/workflows/` 相關 workflow、`package.json`、`observability/build-identity.js`、contract test |
| 產品規劃／待辦 | `docs/planning/` | 只讀尚未完成項目；不要把 roadmap 當成已實作能力 |
| 歷史稽核／發布證據 | `docs/reports/` | 只讀指定報告，確認日期／branch／SHA；不得把舊 PASS 當成目前 head 證據 |

常用定位命令：

```bash
rg -n "symbol|route|setting|error text" server public test
rg -n "page-|POLL_JOBS|fetch[A-Z]|applyPolling|sendHeartbeat" public/index.html public/js
rg -n "app\.(get|post|put|patch|delete)|readUpsLive|createHistoryDb" server.js server
rg -n "SMARTHUB_IMAGE|production-preflight|update-nas|Repository gate" README.md docs .github scripts test
```

## 3. 目前系統的一頁定位

- Node.js `24.18.0`、Express `5.2.1`；套件版本以 `package.json` 與 lockfile 為準，產品版本目前為 `3.0.0`。
- 正式組裝入口是 `server.js`；可測試 owner 在 `server/`；SQLite／WAL／retention／備份在 `db.js` 與 `server/storage/`。
- 前端是 `public/index.html` 的 14 頁 SPA；主要行為在 `public/js/app.js`，生命週期在 `frontend-lifecycle.js`，安全動態操作在 `action-dispatcher.js`。
- `server-mock.js` 是前端契約的假資料邊界，不是另一套產品邏輯；前端可見契約要與 production、mock、test 一起維護。
- 正式 runtime `docker-compose.yml` 只拉 GHCR image；本機／CI source build 必須明確加 `docker-compose.build.yml`。`nas-monitor` profile 預設關閉，Docker socket 代表宿主機高權限風險。
- runtime data 在 named volume `/app/data`；部署設定在獨立 `config/.env` bind mount。不要用 `down -v`，不要把 repository 整個掛進容器。

## 4. 重要流程與不可混淆的邊界

### 瀏覽器與後端

瀏覽器只呼叫同源 SmartHub → Session／Basic 相容驗證、Origin／CSRF／輸入 policy → route → snapshot 或明確上游 client。GET route 應讀 snapshot；背景 sampler 才負責上游 I/O、SQLite、狀態轉移與通知。外部整合失敗通常不阻止 readiness；SQLite 或 worker 異常才會讓 `/health/ready` 失敗。

### 前端更新

初始只載入設定、健康與重大事件；頁面首次進入才 hydration，成功 job 不重做、失敗 job 才重試。一般可見頁面預設 5 秒，UPS 即時狀態 3 秒；heartbeat 只維持實際 page scope。切頁、hidden 或 lease 到期要回到低頻，不要為了「即時」把所有 timer 改成 1 秒。

### 開機與持久化

讀取 `config/.env` → 建立 SQLite／instance lock → 啟動 sampler、report、通知與 health → 接受 request。SIGTERM 要停止新工作、關閉 upstream／SSE、flush／checkpoint SQLite、釋放 lock，並在 Compose 20 秒 grace period 內結束。

### Source build、CI、GHCR、NAS

本機部署：`build overlay` → 新 volume 才初始化 SQLite → `production-preflight.js --offline` → `up -d --no-build --pull never`。Hosted GitHub `SmartHub CI` 則依序做 locked install、syntax／test／CSS／audit、Compose／雙 image build、preflight、獨立 smoke、90 秒 soak、SBOM／Trivy／完整 history Gitleaks 與 release evidence，不代表真實部署已啟動。`Repository gate` 是 required check；成功的 push workflow 由 `Publish SmartHub images` checkout 同一個 exact CI head，發布成對的 amd64／arm64 GHCR image。

NAS 更新：確認 config／volume → `pull` → 只有新 volume 才 `--initialize` → 新 image offline preflight → `up -d --no-build --pull never` → 比對 `/app/data` volume identity。pull／preflight 失敗時不可先停止現有服務；不可用 `down -v`。

## 5. 不要破壞的核心契約

- Production `PANEL_PASSWORD` 至少 16 字元且不可是 placeholder；readonly 密碼必須不同。`TRUSTED_LAN_MODE=false` 是安全預設。
- Docker UPS 的已驗證路徑是 `UPS_SOURCE=ppb`、`PPB_HOST=host.docker.internal`、`PPB_PORT=3052`；明確 source 預設 fail-closed，fallback 必須明確開啟。
- `config/.env` 是 deployment authority；UI 可保存的設定要和 container-create-time 的 `NAS_MONITOR_*`、以及 deployment-only／restart-required 的 `SMARTHUB_INTERNET_PROXY_MODE` 分清楚。
- 新增寫入操作時同時檢查 admin、readonly、CSRF、Origin、輸入驗證、allowlist、確認、錯誤回復與 audit；不能只在前端隱藏按鈕。
- 新增或修改 Tailwind class 後更新 checked-in CSS；不得引入 inline script／handler、`unsafe-inline` 或 `unsafe-eval`。
- 真實 Controller、NAS、UPS、WiiM、AdGuard、SSH、Docker socket、DR、registry pull 或 24／72 小時 soak，不能由 mock、unit test、smoke 或 Hosted CI 推定已完成。

## 6. 驗證選擇

| 變更 | 最小驗證 |
|---|---|
| 純文件／Markdown／HTML | `git diff --check`、`node --test test/documentation-contract.test.js` |
| JavaScript／後端單模組 | 受影響的 `node --test test/<相關>.test.js`、必要時 `npm run check:js` |
| 前端／Tailwind | 對應 frontend test、`npm run check:js`；改 class 再 `npm run check:css` |
| API／mock／安全契約 | production route、`server-mock.js` 與對應 contract test；不要只跑 happy path |
| Docker／部署／依賴／release | 依 `PRODUCTION-RELEASE-CHECKLIST.md`；高風險時才跑完整 local／Hosted gate |

任何測試失敗先保留第一個失敗與 root cause，不要只重跑到綠燈。若使用者指定 GitHub Actions 是唯一驗證權威，禁止自行補跑 local test、build、audit、Docker 或 runtime。

## 7. 文件維護規則

- `README.md`：使用者、部署者與快速操作；不塞歷史 audit 細節。
- `CONTEXT.md`：低上下文路由；只列分類、入口與排除邊界。
- `docs/reference/backend-map.md`／`frontend-map.md`：source owner、搜尋錨點與穩定契約；新增模組時才更新對應 map。
- `docs/operations/`：可重現的現在流程；部署／輪詢／診斷改動要同步更新。
- `docs/integrations/`：單一上游的設定與安全界線。
- `docs/reports/`：日期、branch、SHA 綁定的歷史證據；保留 `NOT RUN`，不要改寫成目前結論。
- 新增、移動或刪除 Markdown 後，更新 `docs/README.md` 與完整 HTML 手冊的文件索引；更新 AI 入口時同步更新 `test/documentation-contract.test.js`。

完成前用 `git diff --name-only` 確認只改授權範圍，並在回覆中說明未讀取／未執行的部分。
