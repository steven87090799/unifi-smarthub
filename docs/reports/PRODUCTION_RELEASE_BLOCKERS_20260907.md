# Production Release Blocking Issues 修復（2026-09-07）

## 範圍

本分支以最新 `main` 為基線，處理正式發布阻擋項：Express 5／`qs`
依賴相容性、Trusted LAN 預設安全性、production panel password preflight、
完整 Git history secret scan，以及 `main` required check branch protection。

## 修復

- Express 升至 `5.2.1`，lockfile 使用 `qs` `6.16.0` 與 body-parser `2.3.0`；production／mock 明確使用 `extended` query parser。
- 新增 Express regression coverage：duplicate／array／prototype-like／unknown query、encoded／malformed URL、JSON／raw body size limit、async rejection 與 after-response error。
- 保留四參數 error middleware 與 `headersSent` delegation，並將 malformed URL 以不洩漏內部訊息的 400 回應處理。
- `TRUSTED_LAN_MODE` 的 source、mock、example、整合文件預設改為 `false`；明確 `true` 仍保留 scoped compatibility 行為。私有 CA 與 SSH fingerprint 仍優先，未 pin 的 Trusted LAN SSH 維持可觀測 warning。
- `PANEL_PASSWORD` 與已配置的 `PANEL_READONLY_PASSWORD` 現在要求至少 16 字元、拒絕已知弱密碼／example placeholder，唯讀密碼必須與管理員密碼不同。
- `SmartHub CI / Repository gate` 使用 pinned Gitleaks binary、完整 checkout 與 `--log-opts=--all` 掃描 Git history；既有 low-level npm audit、Trivy HIGH/CRITICAL、SBOM、Compose、preflight、smoke、soak 與 hygiene gates 保持 blocking。
- `main` branch protection 要求 strict／up-to-date 的 `SmartHub CI / Repository gate`；實際設定與 exact-head workflow 狀態以 GitHub repository／PR 為準。

## 驗證邊界

本次遵守 production release 指示：不執行本地 test、install、audit、build、
Docker、runtime 或實機驗證。唯一驗證權威是 GitHub Actions 的 exact-head
`SmartHub CI / Repository gate`；PR 建立後只確認 workflow 初始已排入佇列／執行，
不等待結果。

以下項目在本次仍為 `NOT RUN`：真實 UniFi Controller、NAS、UPS、AdGuard、
WiiM、SSH、Docker socket、disaster recovery，以及 24／72 小時長時間 acceptance。
