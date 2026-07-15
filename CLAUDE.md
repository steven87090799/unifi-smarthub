# SmartHub — Claude 工作入口

本檔刻意維持精簡。先讀 `CONTEXT.md`，依任務選 `SERVER-MAP.md` 或 `FRONTEND-MAP.md`，再以 `rg`/`sed` 讀相關片段；不要預讀 `server.js`、`public/index.html`、`data/`、`.env` 或 API 規格。

- `.env` 僅在實機 debug 時精準讀取必要欄位；先參考 `.env.example`，不輸出機密。
- 歷史資料使用 SQLite `data/smarthub.db`，沿用 `db.js`，不要恢復整檔 JSON 歷史寫入。
- 前端可見的 API／設定變更要同步 `server-mock.js` 並驗證。
- Docker UPS 使用 PPB REST（`UPS_SOURCE=ppb`、`host.docker.internal:3052`）；容器內 `pwrstat` 不適用。

歷史技術背景在 `spec.md`；live contract 先查 maps、tests 與精準 source。部署資訊在 `README.md`，診斷資訊在 `OBSERVABILITY.md`；均按任務需要才讀。
