# SmartHub Claude 工作入口

先讀 `CONTEXT.md`，再依任務選 `SERVER-MAP.md` 或 `FRONTEND-MAP.md`，最後只用 `rg`／`sed` 讀相關片段。

- 不預讀 `.env`、`data/`、`server.js`、`public/index.html` 或低頻參考文件。
- `.env` 只做必要欄位檢查，不輸出機密。
- 歷史資料沿用 SQLite 與 `db.js`。
- 前端契約變更要同步 `server-mock.js`。
- 架構、部署與診斷分別見 `docs/ARCHITECTURE.md`、`README.md`、`docs/operations/OBSERVABILITY.md`。
