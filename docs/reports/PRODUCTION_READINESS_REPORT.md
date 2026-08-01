# SmartHub 2026-07-29 稽核修復生產就緒報告

日期：2026-07-29

分支：`codex/fix-smarthub-audit-findings`

最終實作版本：PR #5 final Head（完整 SHA 以 PR 與對應 final-head CI run 為準）

CI Workflow：`SmartHub CI`（check：`Repository gate`）

文件基線：`c860af27 docs: consolidate SmartHub documentation and manual` 為刻意保留的正式變更；HTML 操作手冊與現行文件搬移不得回復。

## 結論

狀態：**READY FOR DRAFT PR WITH KNOWN DEPLOYMENT GAPS**

本次稽核要求的程式修復、回歸測試、本機安全 Gate、隔離 Docker build，以及 final-head Hosted CI 的隔離 runtime smoke 已完成。正式 NAS 部署、真實設備破壞性操作、registry push／pull、完整跨瀏覽器矩陣與長時間 soak 沒有執行，因此本報告不把它們視為通過。

## 驗證環境

| 項目 | 實際版本 |
|---|---|
| macOS local Node.js | `v26.4.0` |
| local npm | `11.17.0` |
| CI target Node.js | `20` |
| GitHub Actions runtime | `checkout@v7`／`setup-node@v7`（官方穩定版，Node 24 action runtime） |
| Docker Engine／CLI | `29.4.0` (`9d7ad9f`) |
| Docker Compose | `v5.1.2` |
| 應用程式 | `3.0.0` |

Docker 主映像與 NAS Monitor 映像都以目前 worktree 建置；沒有啟動 NAS Monitor，也沒有掛載真實 Docker socket。

## 修復 Finding

| Finding | Root Cause | 處理 |
|---|---|---|
| Adaptive Polling scope 隔離 | `general` 與全量 rebuild 使不相關設備 sampler 一起加速 | 建立 scope-aware sampler registry；focus 只 prompt matching scope，設定變更才全量重排 |
| Activity Lease 無容量限制 | session／scope Map 只有過期時間，沒有硬上限與淘汰 | 加入 1,000 sessions、每 session 8 scopes、過期優先與 LRU 淘汰，診斷不含 ID |
| SSH shutdown race | pending connection 沒有明確 owner，late ready 可在 close 後回填 | 明確追蹤 candidate／promise／reject owner；close 冪等、拒絕 queued work、late callback 不復活 |
| PPB TLS 不安全預設 | HTTPS agent 無條件停用憑證驗證，且每次請求可能建立 agent | 預設驗證、可掛私有 CA、只有 `PPB_TLS_INSECURE=true` 明確 opt-in；agent 重用、設定輪替與 shutdown destroy |
| PPB 首次同步歷史通知 | 以既有事件列推測初始化，沒有 source-specific durable state | 新增 `integration_sync_state`；首次成功只建 baseline、不通知，失敗保持未初始化 |
| Inline JavaScript／handler | Dashboard 行為與動態字串 handler 混在 HTML，CSP 必須允許 inline | 拆成 `bootstrap.js`、`action-dispatcher.js`、`app.js`；使用 delegated listener 與 escaped data |
| CSP 過寬 | inline 行為使 `script-src` 不能收緊 | `script-src 'self'`，不含 `unsafe-inline`／`unsafe-eval`；Service Worker 納入所有新資產 |
| 缺少 hosted repository gate | PR 只能依賴手動本機敘述 | 新增 `SmartHub CI / Repository gate`，涵蓋 install、syntax、test、CSS、audit、Compose、雙映像 build 與 hygiene |
| Low dependency advisory | Express 的單一 transitive `body-parser@1.20.5` 命中 `GHSA-v422-hmwv-36x6` | 在 Express 4 相容範圍內最小更新至 `body-parser@1.20.6`；未使用 override、major upgrade 或 `--force` |
| Hosted runtime 缺口 | Runtime smoke 原檔名同時符合 Node test discovery，使 `npm test` 與獨立 smoke step 重複執行 | 保留 blocking `npm run test:smoke`，將正式程序改為不可被 test discovery 發現的 `scripts/runtime-smoke.js`，並新增掃描契約 |
| 維護風險 | `server.js` 與 `index.html` 同時承擔生命週期與實作細節 | 抽離 sampler registry、PPB client／sync service 與 Dashboard executable assets |

## 測試與 Gate

| Gate | 證據 |
|---|---|
| `npm ci` | PASS；安裝 282 packages，Exit 0 |
| `npm run check:js` | PASS；133 files，Exit 0 |
| `npm test` | Unit／Integration／Contract／Security；PASS，545/545，0 fail，輸出中 `Runtime smoke PASS` 為 0 次 |
| `npm run check:css` | PASS，Exit 0 |
| `npm run test:smoke` | 獨立 Runtime Smoke；PASS，`Runtime smoke PASS` 與 cleanup 標記各 1 次，兩次 SIGTERM Exit 0 |
| `npm audit --audit-level=low` | PASS；0 vulnerabilities，Exit 0 |
| Docker Compose profiles | 主 profile 與 NAS Monitor profile 都 PASS；使用臨時假設定 |
| Docker builds | SmartHub 與 NAS Monitor 兩個映像都 PASS |
| `git diff --check` | PASS |
| Hosted CI | Final Head 對應的 `SmartHub CI / Repository gate` 成功 run；完整 SHA 與 URL 同步於 PR #5 Body |

Dependency Audit：**0 low、0 moderate、0 high、0 critical**。唯一的 `body-parser` 由 Express 帶入且鎖定為修復版 `1.20.6`；未使用 override，也未使用 `npm audit fix --force`。

## 回歸矩陣摘要

- Scope：只重排匹配 sampler；設定頁不建立設備 scope；多分頁 lease 互不釋放；heartbeat 不累積 timer。
- Lease：容量邊界、LRU refresh／eviction、過期優先、每 session scope cap 與 privacy-safe diagnostics。
- SSH：close-before-ready、queued command reject、late ready／error、double close、每個 candidate 只 end 一次。
- PPB TLS：真實本機 HTTPS 證明預設拒絕不受信任憑證、自訂 CA 成功、明確 insecure 才成功；401／403 只重登入一次；agent 重用與 destroy。
- PPB sync：首次成功不通知、首次失敗不初始化、重啟後持久、reorder／duplicate 去重、同 timestamp 不同 external ID 都保留。
- Frontend：HTML 無 inline script／event attribute；CSP 禁止 inline executable；惡意 `'`、`"`、`</button><script>`、`<img onerror>` 與 handler payload 保持 inert；readonly 不執行 admin action。
- Lifecycle：SIGTERM 停止 sampler、pending SSH、PPB agent、SSE、SQLite 與 instance lock；既有 lifecycle 測試與 Docker exit 0 共同驗證。

## 隔離 Runtime Smoke 證據

| 驗證 | 結果 |
|---|---|
| `/health` | PASS，HTTP 200 |
| `/health/ready` | PASS，HTTP 200 |
| Admin／Readonly form login | PASS，HTTP 200 |
| CSRF endpoint | PASS，HTTP 200 |
| Readonly write | PASS，HTTP 403 |
| Admin write without CSRF | PASS，HTTP 403 |
| Admin safe write with CSRF | PASS，HTTP 200 |
| SIGTERM | PASS，兩次 Exit Code 0，未 OOM |
| Restart／SQLite settings | PASS；安全設定於相同臨時 DATA_DIR 重啟後仍存在 |
| Temporary resources cleanup | PASS；child process、臨時 DATA_DIR／config／`.env`、cookie 與 lock 已移除 |

Hosted smoke 使用正式 `server.js`、動態 loopback port、loopback 假設備位址、假登入資料、空整合 credential 與停用通知的預設狀態；沒有連線真實設備、啟動 NAS Monitor mutation 或掛 Docker socket。這項 PASS 只代表 hosted isolation，不代表正式 NAS deployment、真實設備 destructive testing 或長時間 soak。

## CI 與 Branch Protection

本歷史 PR #5 報告的 workflow 使用官方穩定 `actions/checkout@v7` 與 `actions/setup-node@v7`，當時專案測試仍由 setup-node 安裝 Node.js 20；本次 long-run hardening 已把 current branch 與 Docker runtime 升至 Node.js 24.18.x。原 hosted action runtime 警告已消除，沒有使用 beta、第三方 fork 或不安全繞過環境變數。

Pull Request 與 `main` push 會執行 `SmartHub CI`。本次在確認 repository Admin 權限、`main` 沒有既有 branch protection 且 ruleset 為空後，已設定：

1. 將 `SmartHub CI / Repository gate` 設為 Required Check。
2. 要求分支在 merge 前為最新。
3. 禁止 check 未成功時 merge。

Branch protection 設定狀態：**PASS**；required status checks 的 `strict=true`，唯一新增 context 為 `SmartHub CI / Repository gate`。`enforce_admins=false`，因此 Repository Owner 仍保有緊急修復能力；未新增 review 限制、push restriction 或其他 ruleset。

## Soak 與資源

- 長時間／多日 soak：**NOT RUN，0 小時**。
- 本次只有短時間完整測試與決定性 concurrency／capacity 模擬；這些證明 timer、Map、agent 與 connection owner 有界，不等同正式長期 soak。
- Runtime Smoke 是短時間功能／shutdown／restart 驗證，不是效能 soak。

## 未執行

| 項目 | 狀態 | 原因／下一 Gate |
|---|---|---|
| 正式 NAS 部署 | NOT RUN | 需目標主機、備份與部署授權 |
| 真實 UniFi／NAS／UPS／WiiM／AdGuard／Linux 破壞性操作 | NOT RUN | 本次明確保護真實設備 |
| NAS Monitor socket-backed runtime mutation | NOT RUN | 沒有掛載真實 Docker socket |
| Registry Push／Pull 與 digest 驗證 | NOT RUN | 只做本機 build |
| 完整跨瀏覽器／裝置矩陣 | NOT RUN | 自動契約與 runtime smoke 不等同完整瀏覽器矩陣 |
| 正式 Disaster Recovery Restore | NOT RUN | 需要正式備份與隔離維護窗 |
| 多日／數月 Soak Test | NOT RUN | 本次執行時間不構成長期觀察 |

## 剩餘風險

- 真實 PPB 的 certificate chain、redirect 行為與 firmware API 仍須在受控部署環境驗證；私有 CA 應優先於 insecure opt-in。
- PWA 更新後，已開啟的舊分頁可能在 Service Worker activate／reload 前仍使用上一版 cache；部署後應重新載入並確認新 cache。
- 真實多分頁背景節流、Safari／Firefox／Chromium 差異尚未做完整矩陣。
- NAS／設備 API、SSH 與網路延遲的實際分布未由本機 loopback mock 覆蓋。
- 依賴安全 gate 已收緊為 low；未來任何 low 以上 advisory 都會阻擋 CI，registry 暫時不可用時也不會被降級為可選檢查。

## 發布判定

PR #5 維持 Draft 且未 merge。只有 final Head 的 `SmartHub CI / Repository gate` 成功、branch protection 設定完成、且部署人員接受上述 `NOT RUN` 項目後，才能進入受控 NAS 部署；本報告不授權 merge。
