# SmartHub 產品路線圖

只保留尚未落地的方向；目前能力以 [README](../../README.md)、[後端地圖](../../SERVER-MAP.md)、[前端地圖](../../FRONTEND-MAP.md) 與測試為準。

## 近期

1. WiiM 鬧鐘排程：固定產品指令、SQLite schedule、timezone、restart recovery、二次確認。
2. UniFi Guest voucher：短期憑證、同源 QR、expiry、audit、admin-only。
3. NAS Monitor alert policy：上游契約穩定後再開放，與 Docker actions／logs 權限分離。
4. AdGuard DNS rewrite／安全搜尋：沿用 transport、baseline ownership 與 reconciliation。

## 中期

- 受限 UniFi firewall policy enable／disable；禁止任意 payload，需保護管理路徑、確認、audit、rollback。
- 報表圖表以本機 SVG／PNG 附件產生，不送往第三方 chart service。
- 部署層 exporter：RSS、CPU、restart、volume、issue／task metrics，避免 secret 與高基數 label。
- 逐步抽出 NAS／UniFi clients，優先改善 timeout、credential boundary、test seam 與 lifecycle ownership。

## 長期

- 從 `server.js` 逐一抽出有 contract tests 的 route／client／job owner，避免一次重寫。
- 從 `public/index.html` 逐一抽出 polling／API／頁面模組。
- 評估 event stream 取代部分輪詢；先證明 auth、reconnect、backpressure、visibility 與行動裝置耗電。

## 不做

- 任意 WiiM command、Docker ID／action、firewall payload 或 SmartHub 自身容器操作。
- 把 Docker socket 掛入 SmartHub 主服務，或預設啟用 NAS Monitor。
- 把 WiFi、credential 或遙測送往第三方 QR／chart service。
- 把容器內 `pwrstat` 當 Docker UPS 路徑。
- 以整檔 JSON 取代 SQLite 歷史。
