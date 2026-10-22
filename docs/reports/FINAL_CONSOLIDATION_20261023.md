# SmartHub 3.0.4 分支整合與清理

日期：2026-10-23。整合基線：`5ac4e45827241d56c6d744e0c6e7f5d032bc0d07`。

## 最終版本的修正

- 整合 Dependabot #34、#35、#37 的 proxy-addr、source-map-js、follow-redirects 更新；#36 的 Tailwind 4 更新另補齊新版 CLI、明確 source、相容樣式與產出，沒有直接合併失敗的更新。
- Tailwind CLI 使用已修補的 `@parcel/watcher` 2.6.0 override；原本的 watcher 2.5.1 仍包含有漏洞的 glob dependencies。正式與開發依賴均須通過完整 audit。
- tzdata 固定版本更新為 Alpine v3.24 當前提供的 `2026e-r0`。x86_64／aarch64 官方 APKINDEX 均已核對，其他直接套件 pin 沒有變更。
- 從 stash／舊 release-blockers 分支補回仍缺少的備份遮蔽、未知遙測狀態、感測器有效值檢查與告警狀態保存。保留較新的 radio stats、UCG sampler 重用、SQLite rollup、取樣與快取設計。
- Controller 未提供 online／VAP／uplink／完整用戶數時保留未知值，不冒充離線或零；production、mock、UI 與回歸測試同步。
- Device SSH 只採用已選取、fresh、supported、範圍有效的 sensor；保留 PR #32 的所有感測器最高溫與完整 zones，UI 明確標示其意義。UCG 則沿用已辨識來源的 CPU sampler，不把舊 stash 的 CPU-only 行為覆蓋新版 AP 設計。
- 告警狀態保存於 SQLite，最多保留 1000 台、90 天；忽略重複與較舊的樣本。SSH 設定變更時同時清除記憶體與保存狀態，避免重用舊設定的告警。
- package／lockfile／目前版本文件統一為 3.0.4。

## 舊分支與本機內容的處置

整合前已建立並驗證完整 Git bundle，包含所有 branch、tag、stash 與已註冊 worktree HEAD。清理在最終 PR 合併後進行；未追蹤設定及機密檔先移至 repository 外的受限封存，不放進 Git。

| 分支／內容 | 最終處置理由 |
|---|---|
| 已是 main ancestor 的歷史分支 | 已整合，合併後移除多餘 branch ref |
| PR #17–#27、#31–#33 的原分支 | 依已合併 PR head／patch equivalence 核對；保留 main 中的較新實作 |
| `codex/fix-adguard-active-sampling-20261004` | 整合前完整 tree 與 main 完全相同，PR #33 已合併 |
| `codex/polling-cache-hardening`、`codex/unifi-device-telemetry` | 舊 salvage 已由 PR #6／#7／#14／#15 整合或強化；本次保留目前 collector、SSH lifecycle、SQLite rollup、soak 與 telemetry tests，沒有整檔回復舊程式 |
| `codex/console-ui-redesign` | 由 PR #27 的安全前端組裝及目前 console stylesheet／外部 script 取代；保留後續 UI 改進 |
| `codex/fix-release-blockers`、stash | 所需差異選擇性補回；不恢復較舊的 history pagination、one-shot UI hydration、TLS owner 或 artwork proxy |
| `codex/ghcr-nas-deploy` 的後續提交 | 目前成對私有 GHCR 發布、精準 CI head、platform digest 掃描與較新 security pins 已取代舊配置 |
| `audit/production-readiness-20260916`、`codex/production-readiness-deep-audit-20260916` | 只含暫時性 audit workspace workflow；不屬於產品功能，封存而不加入正式 workflow |
| Dependabot #34–#37 | 所需更新已在本次整合；合併後關閉被取代的 PR 並移除 branch |
| 額外工作樹的 Compose／`.env` | 先封存本機設定，再移除多餘工作樹；只保留主專案目錄 |
| 舊 ZIP、下載的原始碼副本、ignored 驗證產物 | 核對／保存必要設定與歷史後整理；不刪除正式 data／config、備份或 NAS 服務 |

## 舊 release-blockers 的 source 對應

`6a7fc34` 的 31 個變更檔案依責任分組核對：

| 舊修改範圍 | 保留的現在實作 |
|---|---|
| `.env.example`、README、整合與 operations 文件 | 目前 scoped Trusted LAN、私有 CA、SSH pin、UPS fail-closed 與唯讀部署邊界 |
| `server.js` TLS／SSH／連線設定、write-input policy | `server/integrations/tls-policy.js`、`ssh-host-key-policy.js` 與目前輸入驗證，不恢復舊的重複 TLS owner |
| WiiM artwork proxy／tests | 目前 numeric IPv4/IPv6 分類、DNS pin、逐跳驗證、deadline、併發與 cache bounds；舊 166 行 proxy 已被強化版本取代 |
| SQLite／history query／UI history | 保留 raw／rollup 混合、有界 point budget 與多時間範圍圖表；舊 raw-only cursor 與只載入一次的列表不適用 |
| 備份設定遮蔽／tests | 補回單數 `HOST_KEY` 與複數 `HOST_KEYS` 的共同遮蔽 |
| telemetry normalization／alerts／tests | 補回未知值、有效 sensor 與持久告警，並保留後續 main 的 radio stats／UCG 資料來源 |
| CI／`compose-runtime-smoke.js`／package | 目前正式 workflow 的 isolated Compose preflight、runtime smoke、restart persistence、soak、SBOM／Trivy 與 release evidence 已取代舊腳本 |

## 驗證與實機邊界

Local：執行對應回歸測試、完整測試、JS／CSS 檢查、正式與完整依賴 audit、runtime smoke／短 soak 及 diff hygiene；實際結果保存在本機整合紀錄，最終 PR 另附驗證結果。

Hosted：必須以最終 PR head 的 `Repository gate` 通過後才合併。main／版本 tag 的 gate、成對映像發布及 registry scan 另以 GitHub Actions exact-head 結果記錄，不能以 local test 取代。

NAS、Controller、UPS、WiiM、AdGuard、SSH、實際資料還原及長期實機 soak：NOT RUN。本次不操作正式 NAS 或其他專案服務。

參考：[Tailwind 官方升級指南](https://tailwindcss.com/docs/upgrade-guide)、[proxy-addr advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)、[follow-redirects advisory](https://github.com/advisories/GHSA-q3jh-wrc6-jgq8)。
