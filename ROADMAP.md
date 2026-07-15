# SmartHub Product Roadmap

本文件只保留尚未落地、仍值得評估的產品方向。已完成能力以 `README.md`、`SERVER-MAP.md`、`FRONTEND-MAP.md` 與測試為準；正式發布 gate 以 `PRODUCTION-RELEASE-CHECKLIST.md` 為準。

## 已從舊 roadmap 落地

- SQLite 歷史、事件、排程、通知與 policy persistence，含 retention、WAL、backup/restore 與 restart recovery。
- Readonly/admin 角色、CSRF/origin/write-route security contracts 與 Basic Auth bounded throttling。
- UniFi public IPv4 threat-source temporary blocks，含 expiry、audit、dedupe 與 failure reconciliation。
- AdGuard per-device YouTube/TikTok/Gaming policies，含 timezone allow window、baseline restore 與 bounded retry。
- Web Push subscription/delivery lifecycle，含 persistent dedupe、expiry cleanup、retry/backoff 與既有 channel fan-out。
- NAS Monitor SSE、canonical Docker identity、separate mutation/log allowlists、credential isolation 與 optional Compose profile。
- Site Manager bounded pagination、repeated-token protection與 429 `Retry-After` handling。
- 同源 frontend runtime assets 與 Guest WiFi QR；不再依賴第三方 CDN/QR service。

## 近期候選

1. **WiiM 鬧鐘排程**：只開放明確產品指令，以 persistent schedule、timezone、restart recovery 與二次確認保護 device mutation。
2. **UniFi Guest voucher**：使用 Integration API 產生/撤銷短期憑證，QR 維持同源產生，加入 expiry、audit 與 admin-only policy。
3. **NAS Monitor alert policy management**：若 upstream contract 穩定，再讓面板管理 threshold；必須與 Docker action/log 權限完全分離。
4. **本地 DNS rewrite / 安全搜尋控制**：在 AdGuard transport 與 per-device policy abstraction 上擴充，保留 baseline ownership 與 recovery reconciliation。

## 中期候選

- UniFi firewall policy 的受限 enable/disable surface；禁止任意 rule payload，且需 protected management path、二次確認、audit 與 rollback。
- 報表圖表以本機產生的 SVG/PNG 附件呈現，不把 telemetry 或 credential 送往第三方 chart service。
- 長期 observability exporter：container RSS/CPU、restart count、volume growth、issue/task metrics；不將 secret 或高基數 identity 放入 label。
- NAS / UniFi integration clients 的漸進抽取，優先改善 timeout、credential boundary、test seam 或 lifecycle ownership。

## 長期架構

- 從 `server.js` 逐一抽出具備 contract tests 的 client、route 與 recurring job owner；避免一次重寫。
- 從 `public/index.html` 逐一抽出 polling/api 與單一 feature module；先盤點 global state、DOM ownership、timer/listener 與 script order。
- 評估 server-driven event stream 取代部分高頻 polling；需先證明 reconnect、backpressure、auth、visibility lease 與 mobile power 行為。

## 明確不做

- 不提供任意 WiiM command、任意 Docker ID/action、任意 firewall payload 或可修改 SmartHub 自身容器的 broker surface。
- 不將 Docker socket 直接掛入 SmartHub 主服務，也不預設啟用 NAS Monitor。
- 不把 WiFi、API、notification 或其他 secret 送往第三方 QR/chart service。
- 不把容器內 `pwrstat` 當成 Docker UPS 路徑；已驗證路徑是 PPB REST，NUT 是可選替代。
- 不用整檔 JSON 寫回取代既有 SQLite 歷史資料。
