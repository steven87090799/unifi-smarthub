# SmartHub 生產就緒報告

> 這是 2026-07-16 的最終生產強化驗證報告；保留完整證據，不作一般上下文預讀。

日期：2026-07-16
分支：`production-hardening-final`
最終審查的工程版本：`58809e9c192af3a7092665473324018e7fc8689c`

## 最終結論

READY WITH KNOWN RISKS

中文結論：**已具備上線條件，但仍有已知風險。**

在目前可用的本機環境中，此 repository 已達到能由證據支持的最高生產就緒程度。20 項已確認發現均已修復並提交，包括所有受調查的 P0／P1 項目，以及所有已確認的重大／高風險。完整測試 483/483 通過、依賴套件 audit 為零漏洞、乾淨的成對映像能以嚴格身分建置，隔離 Docker 的啟動、重啟、重建、持久化、安全、失敗與停止契約也都通過。

這項結論不代表程式完全沒有缺陷。Registry 發布／拉取、最終目標主機部署、真實破壞性裝置操作，以及數月長時間 soak test，皆不在本次授權或執行時間範圍內。這些限制仍是發行與維運階段必須負責的項目。

## 已審查的架構

- Node.js／Express 正式環境入口、middleware 順序、驗證、授權、CSRF／Origin policy、輸入驗證、錯誤處理、啟動與停止。
- SQLite 歷史、報告、Web Push、威脅政策持久化、migration、熱門查詢、資料保留、還原順序與單一 owner 生命週期。
- 週期性工作：通知與 Auto Defense jobs、歷史取樣器、UPS 輪詢、威脅與 AdGuard reconciliation、報告 claim／renewal／deadline、Telegram 輪詢、診斷及 NAS Monitor SSE。
- 外部邊界：UniFi 本機／Site Manager、UGREEN NAS、NAS Docker monitor、WiiM、CyberPower UPS、AdGuard、Linux／UCG SSH、Discord、Telegram 及 Web Push。
- 單頁前端的關鍵載入、輪詢、寫入控制、待重啟狀態、備份／還原、威脅封鎖、AdGuard policy、Web Push、離線資產、QR 產生及 readonly 行為。
- Docker／Compose 主服務、可選的高權限 socket broker、健康／就緒狀態、volumes、設定權威、不可變 build identity、發行交易、重啟政策及優雅停止。

強化工作逐步抽離安全 middleware、policies、routes、jobs、storage、integrations、Web Push 後端 routes，以及前端 Web Push module；沒有對 `server.js` 或 `public/index.html` 進行風險很高的全面重寫。

## 初始待辦處理結果

| 待辦項目 | 處理結果 | 主要 commits |
|---|---|---|
| P0 面板驗證、CSRF、Origin、限流、readonly／admin 角色 | 已修復並完成契約測試 | `69ad002` |
| P0 無限制 WiiM 命令代理 | 以型別化讀寫 allowlist、method 分離、驗證及高風險確認完成修復 | `0e8f05a` |
| P1 統一寫入／查詢驗證與 `.env` 注入防護 | 正式與 mock routes 均已修復 | `8aeeb26` |
| P1 UPS debounce、最後有效狀態、離線／恢復轉換 | 已修復，並有決定性故障／復原 runtime 證明 | `8aeeb26` |
| P1 排程報告重啟／並行冪等性 | 以 SQLite claims、fencing、重試、期限及資料保留完成修復 | `8aeeb26` |
| P1 Site Manager 分頁與 429 處理 | 以有界頁數／項目、token 迴圈拒絕、`Retry-After`／backoff 及終端 metadata 完成修復 | `8aeeb26` |
| 程序停止、jobs、SSE 與 SQLite 生命週期 | 已修復，並以真實程序／容器驗證 | `8aeeb26`, `601364b` |
| 唯讀使用者模式 | 已在伺服器端涵蓋所有寫入類別 | `69ad002` |
| 設定備份／還原 | 已完成不洩漏機密的匯出及重啟分階段交易式還原 | `c85e0a2` |
| 威脅來源 IP 封鎖 | 已透過官方 Integration API 邊界支援具到期時間的公開 IPv4 | `790d561` |
| AdGuard 服務政策與排程 | 已完成持久的各裝置 policy 與 reconciliation | `19a1d1d` |
| Web Push | 已完成有界持久訂閱、送達 claims、清理與 fallback | `e945df5` |
| 後端／前端拆分 | 已在安全、生命週期、持久化、route 與 Web Push 邊界完成 | 多個；主要為 `d3df8f6`, `58809e9` |
| 文件與正式發行 checklist | 已同步至不可變的成對映像／設定權威 | `8870011` |

要求的新功能沒有尚未實作或遭阻擋的項目。

## 重大與高風險發現

目前沒有未解決的重大發現。已確認高風險的最終處理如下：

- F-001–F-002：缺少面板安全控制及無限制 WiiM 控制——已修復。
- F-003–F-005、F-007：不安全寫入、UPS 狀態遺失、報告重複及程序生命週期缺口——已修復。
- F-008、F-010：高權限 Docker broker 邊界與部署設定／build identity——已修復；乾淨 socket-backed 演練通過。
- F-011：第三方前端 runtime 依賴及 WiFi QR 憑證外洩——已改用同源鎖版資產與本機 QR render。
- F-012：AdGuard 憑證經隱含明文 HTTP 傳送——已改成 HTTPS 預設及精確不安全 opt-in。
- F-017：Auto Defense 永久抑制及輪替 MAC 無界保留——已改為有界、可到期 owner，並加入破壞性時間戳驗證。
- F-018：原地截斷 JSON 設定及先改 live state、後持久化——已改為 atomic 私有替換與 persist-before-publish 交易。
- F-019：DATA_DIR claim race 與 PID namespace 重複 owner——已採交易式租約 runtime／PID／token owner、精確 heartbeat／release 及 owner-loss fail-safe shutdown。
- F-020：無界／停滯的 UCG／Linux SSH 命令 stream——已加入端到端 deadline、合併 byte cap、abort 及 cleanup owner。

## 重要中風險發現

- F-006：Site Manager 分頁／429 行為——已修復。
- F-009：可選 NAS Monitor 錯誤影響部署 readiness——已修復；主服務 readiness 保持獨立。
- F-013：發行身分使 Docker 依賴／payload cache layers 失效——已修復；僅身分 rebuild 由重現的 52.9 秒重新安裝降至主映像 2.6 秒、monitor 2.0 秒。
- F-014：Docker 指標冷卻資料保留——已加入移除清理及 2,000-entry 上限。
- F-015：可復原失敗冷卻資料保留——已加入明確 owner、移除清理及 2,000-key 上限。
- F-016：操作／發行文件漂移——已統一設定權威及不可變成對映像流程。

## 主要修復內容

- 集中式授權／CSRF／Origin／rate-limit middleware 與共用精確輸入 policies。
- 耐久報告排程、有界 jobs、具 owner 的 timers／SSE 及優雅停止。
- Fail-closed Docker socket broker 憑證、標準 64-hex 身分、操作／log allowlists、代理隔離、回應／佇列／並行限制及受保護容器。
- Atomic `.env` 與 JSON 持久化、真實待重啟狀態、交易式還原及精確 DATA_DIR owner。
- 同源前端 runtime 資產、嚴格 CSP、本機 QR 產生及以發行版為範圍的 PWA cache。
- 安全 AdGuard 傳輸，以及持久 AdGuard／威脅／Web Push 能力。
- 有界長期 Set／Map、遙測／歷史／報告保留及故障冷卻。
- 嚴格乾淨 build identity、不可變成對映像交易、部署 checklist 及可有效使用 cache 的 Dockerfiles。
- UCG／Linux 端到端有界 SSH 命令通道／stream owner。

## 安全性審查

- 已驗證 admin／readonly／未驗證身分在安全讀取與所有不安全 methods 的矩陣。
- 已驗證 CSRF token＋同源強制、惡意 Origin 拒絕、Basic Auth 限流／冷卻、有界 limiter state 及明確 trusted-proxy policy。
- 已驗證精確寫入 body／query、識別字／MAC／port／enum 上限、未知欄位、超大 JSON，以及 CR／LF／NUL／shell assignment 注入拒絕。
- WiiM 使用 allowlists 與確認；威脅封鎖和裝置操作都要求伺服器端 policy 及明確確認。
- Docker logs 僅限 admin；異動要求 admin、CSRF、標準 ID、明確 broker capability 及目標 allowlist。Broker 與 SmartHub 容器本身受保護。
- NAS Monitor 與 AdGuard 憑證受來源限制、停用代理、有界、遮蔽，遠端傳輸預設採安全模式。
- 前端可執行資產與 WiFi QR 資料留在同源；CSP 及瀏覽器測試涵蓋關鍵流程。
- 最終版本執行 `npm audit --audit-level=high` 為零漏洞。

沒有即時憑證被提交或由備份格式匯出。Runtime log 掃描未發現演練密碼、API keys、SSH fixture secret 或 Basic credential patterns。

## 可靠性審查

- 具名稱的 `runSerialJob` owner 可防止週期性 job 重疊，並追蹤跳過／失敗。
- 報告 claim、renewal、deadline、完成歧義、重試及 stale 復原均由 SQLite token fencing 保護。
- UPS 保留最後有效資料，能區分降級、確認離線及恢復狀態，不會造成通知風暴。
- 外部 HTTP clients 使用有限 timeout；Site Manager 與 Web Push 重試有界且考慮副作用。
- UCG／Linux SSH 具 8 秒 ready timeout、12 秒總命令 deadline 及 1 MiB 合併輸出上限。
- JSON 與 env 更新使用同目錄私有暫存檔、fsync、atomic rename 及明確的耐久性歧義錯誤。
- 單一租約 SQLite 權威可跨程序與 PID namespace 保護 DATA_DIR restore、主 SQLite、jobs 及通知。
- Shutdown 會清除自有 timers／SSE、停止 bots／monitor／report runner、排空 jobs、安全時關閉 SQLite，且只移除精確 instance owner。

## 效能量測

- Docker cache 重現：僅身分 rebuild 不再觸發 52.9 秒依賴重新安裝；實測主映像 2.6 秒、monitor 2.0 秒。
- 六個等量耐久 waves 未出現明顯 SQLite 延遲惡化：
  - 60,000 次遙測寫入：每 wave 198.82–207.34 ms。
  - 2,000 份手動報告：80.92–82.54 ms。
  - 1,000 個排程身分：145.23–148.15 ms。
  - 15,000 次 Web Push claims：1,388.01–1,468.84 ms。
- 查詢計畫使用 `idx_history_series_ts`、`idx_report_runs_schedule_key` 與 Web Push 建立時間 covering index。
- 加速測試期間 database pool size 維持 1、active connections 回到 0、slow-query count 為 0。

## 故障注入

已執行的決定性場景包括：

- 缺少／無效 CSRF、惡意 Origin、readonly 異動、重複登入失敗、冷卻復原、格式錯誤／超大 body 及 `.env` 注入。
- UPS timeout waves，涵蓋降級／離線／恢復轉換。
- Site Manager 重複／循環 token、錯誤分頁、429 搭配有效／無效 `Retry-After`、重試耗盡及 timeout。
- 報告重疊、程序重啟復原、lease loss、hard deadline、部分送達、假完成及完成重試歧義。
- Atomic env／JSON 部分寫入、fsync、rename、目錄 fsync 故障及中斷還原 rollback。
- NAS Monitor 停滯 SSE、Docker 回應／佇列／並行限制、操作 timeout 歧義、monitor 停止、broker socket 生命週期及憑證輪替。
- Docker instance lock 遺失／stale contention、不同與相同 hostname 的兩個 PID-1 容器、非預期程序 crash、token replacement、lease expiry 及精確 release。
- SSH channel-open stall、stream stall、合併輸出超限、stream error、late callback、start failure 及無效非同步 stream。
- 威脅、UPS、monitor 及最終 UCG SSH runtime 路徑的重複外部連線拒絕。

遭退件或假陽性的嘗試均保留為證據並修正，沒有直接盲目重跑。

## 耐久性與資源觀察

加速測試在單一 Node 程序執行六個 waves，涵蓋 tasks、issues、Docker cooldowns、recoverable failures、activity leases 與 UPS state 的 600,000 輪 owner 操作；300,000 個驗證身分；360,000 筆遙測寫入；90,000 次 Web Push claims；以及有界報告／訂閱／reconciliation 工作量。

- 每個 wave 後 SQLite `quick_check` 均通過；暫存資料庫穩定在 5,464,064 bytes。
- 保留 rows／entries 符合設定上限：每序列遙測 1,000、手動報告 50、排程身分 512、Web Push claims 10,000、auth maps 1,000、cooldown maps 2,000。
- GC 後 heap 從 baseline 到最後增加 797,416 bytes；最後三個 waves 增加 31,304 bytes。
- External memory 與 array buffers 回到相同值；active-handle 差值為 0。
- V8 分段配置 heap 時，RSS 從 53,608,448 增至 174,243,840 bytes；最後三個 waves 的 RSS 差值為 12,189,696 bytes，低於宣告的 32 MiB tail threshold。

這是有力的有界循環證據，但不是 365 天證明。正式環境仍須監控 RSS／heap／handles 與資料庫大小。

## Docker 與發行演練

完整 socket-backed 發行演練涵蓋精確 build identity、health／readiness、身分驗證、readonly／admin Docker logs、標準 ID、受保護容器、一次性操作目標、設定持久化、憑證輪替、一般重啟、協調 recreate、可選 monitor outage、SQLite 完整性、機密掃描及優雅停止。

F-019 在 `601364b` 的 owner 驗收另證明：

- 共用一個 DATA_DIR 的不同 hostname 與相同 hostname PID-1 重複程序皆以 exit 1 結束。
- 非預期 Node failure 被 fencing 六次重啟嘗試，lease 到期後 15 秒恢復健康。
- 精確 token replacement 產生一次 critical owner-loss event、採 fail-safe shutdown，並在到期後 16 秒復原。
- 兩次優雅 stop／start 循環皆 exit 0，停止期間沒有留下 owner row。

最終在 `58809e9` 的乾淨發行交易產生：

- `unifi-smarthub:58809e9c192a` — `sha256:7565af80a309d51da1cf9a51a25bc4935f4f0f51d70998a74387e3adbd53d219`
- `unifi-smarthub-nas-monitor:58809e9c192a` — `sha256:23bec7001d4d8fdd6df043be8e6eba815cd92b9941d871812185883408e90f13`

全新 final-HEAD 啟動、broker／security／config 流程、實際有界 SSH failure、一般重啟、force-recreate、SQLite 檢查、精確映像檢查、機密掃描及優雅停止均通過。所有一次性 containers、networks 與 volumes 均已移除。

## 測試命令與實際結果

最終接受的命令／結果：

| 命令或關卡 | 結果 |
|---|---|
| `node --test test/ssh-command-stream.test.js test/server-lifecycle.test.js` | 10/10 通過 |
| `npm test` | 483/483 通過 |
| `npm audit --audit-level=high` | 0 個漏洞 |
| `npm run check:css` | 通過；checked-in CSS 可重現 |
| repository 中每個 JavaScript 檔案的語法檢查 | 通過 |
| `docker compose config --quiet` | 通過 |
| `docker compose --profile nas-monitor config --quiet` | 通過 |
| `git diff --check` | 通過 |
| `npm run release:build` | 從乾淨 `58809e9` 執行通過 |
| 隔離 final-HEAD Docker 演練 | 通過並已清理 |

較早的聚焦矩陣還包括 100 項正式／mock route 檢查、瀏覽器／runtime 流程、真實程序重啟／還原、12 程序 lock contention、50,000／600,000-entry 保留證明及六-wave 耐久測試。

## 受阻或無法執行的驗證

- 未獲授權執行 registry push／pull 及以 digest 為基礎的乾淨主機部署。本機不可變 tags 與 image IDs 並非 registry digests。
- 未獲授權執行正式環境部署、merge 或 push。
- 未對真實 UniFi、NAS、WiiM、PoE、AdGuard、UPS 或非一次性 Docker 資源發送破壞性操作。
- 無法取得最終目標主機的 kernel／filesystem／network 相容性及外部服務版本進行驗證。
- 本次執行時間無法完成數月或 365 天 soak test。
- 瀏覽器檢查只涵蓋本機可用的關鍵流程，沒有完整跨瀏覽器／裝置矩陣。

## 已知剩餘風險與程式限制

- 短時間加速耐久測試無法排除緩慢的 native／V8 RSS 成長；正式環境需監控 RSS、heap、handles、SQLite 大小、job failures 及 restart count。
- Instance owner 設計刻意優先安全：非預期 crash 可能造成數次重啟失敗，以及約一個 lease／health window 的暫時不可用，之後才恢復。
- 若可信任的本機裝置只支援 self-signed TLS 或不安全 transport，部分整合允許明確 opt-in；這些裝置必須留在受控網路，能用安全選項時應優先使用。
- 真實上游 firmware／API 漂移、目標主機 Docker socket 權限、certificate chain、push delivery 及通知供應商，都必須在部署環境再驗證。
- 本機發行映像只以 image ID 驗證；registry provenance／signing 與最終主機 disaster-recovery restore 仍是操作關卡。
- 系統目前是 Node.js／Express 單一應用程式配合 SQLite；主要資料庫連線池刻意維持 1，適合目前家用面板規模，不代表可直接水平擴充成多寫入節點。
- NAS Monitor 需要高權限 Docker socket broker，但已設為可選服務；若停用或故障，主服務仍可 ready，但 Docker 監控／操作能力會受限。
- 外部裝置與雲端 API 都可能失敗或逾時；程式已做有界重試與降級，但無法保證第三方服務可用性。

## 提交時序

| Commit | 結果 |
|---|---|
| `69ad002` | 面板授權、CSRF／Origin 防護、驗證限流、readonly 角色 |
| `0e8f05a` | 受限制的 WiiM 命令 policy 與寫入邊界 |
| `8aeeb26` | 寫入驗證、UPS 狀態、耐久報告、Site Manager、shutdown／jobs／SSE |
| `46cd237` | Docker monitor 安全、發行／設定身分、restart／recreate 耐久性 |
| `c85e0a2` | 交易式且不洩漏機密的設定備份／還原 |
| `790d561` | 具到期時間的公開 IPv4 威脅封鎖 |
| `80bbec2` | 自行託管前端 runtime、CSP、本機 QR 產生 |
| `a7c0e40` | 安全 AdGuard 憑證傳輸 |
| `19a1d1d` | 持久排程的 AdGuard 服務 policies |
| `e945df5` | 持久且有界的 Web Push |
| `d3df8f6` | Web Push 後端／前端 module 抽離 |
| `be24c43` | 保留 Docker 依賴／payload cache |
| `4bc3024` | 有界 Docker 通知冷卻狀態 |
| `f3ab9a7` | 有界可復原失敗狀態 |
| `8870011` | 正式發行／設定／操作契約 |
| `b1ceb92` | 有界 Auto Defense 封鎖狀態 |
| `6d051f7` | Atomic JSON 設定及 persist-before-publish 行為 |
| `d077366` | 初版交易式 instance owner；後因 PID namespace 證據重新開啟 |
| `601364b` | 跨容器租約 instance owner 及 owner loss fail-safe |
| `58809e9` | 端到端有界 SSH 命令執行 |

## 發行決策

本 repository 已可進入受控的正式部署流程，但必須遵守上述未完成驗證與已知風險。部署應依 [正式發布檢查清單](../operations/PRODUCTION-RELEASE-CHECKLIST.md) 執行，使用不可變成對映像交易，驗證目標主機 Docker socket GID／設定權限，完成文件所列 health／readiness／restart 檢查，並保留 rollback images 與設定備份。
