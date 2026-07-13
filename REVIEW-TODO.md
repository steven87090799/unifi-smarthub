# SmartHub — 待辦與驗證

> 只保留尚未完成的工作；已落地的 XSS 防護、上游 timeout、背景 job guard、可見頁 polling 與設定欄位限制，請以程式碼與測試為準。

## P2：漸進式架構拆分

### [ ] 拆分 `server.js`

目前正式後端仍集中 client、routes、排程與裝置協定。以不改變 endpoint contract 為前提，逐步抽出：

- `server/clients/`：UniFi、Cloud、NAS、WiiM、UPS。
- `server/routes/`：依設備與設定分組。
- `server/jobs/`：trend、notification、NAS、WiiM、UPS。
- 共用 timeout、retry、serial job 與錯誤 helper。

### [ ] 拆分 `public/index.html`

先抽共用安全輸出 helper、polling manager 與 CSS，再依頁面抽 client/security/NAS/WiiM/UPS；避免一次重寫或變更既有 UI/endpoint 行為。

## 低優先 API 改善

- Site Manager 處理 `nextToken` 分頁。
- 對 HTTP 429 建立有限退避策略。
- 在適當時機把可遷移的本地 Legacy API 改為 Integration API。

## 尚待驗證

- [ ] 啟動 mock server，檢查主要頁面 API。
- [ ] 以惡意 alias、Docker 名稱、NAS log、AdGuard domain 驗證 XSS 防護。
- [ ] 模擬上游 timeout，確認 route 有限時返回且背景 job 不重疊。
- [ ] 隱藏／切換分頁，確認 polling 暫停與恢復正確。
- [ ] 測試設定邊界值與非法值。
