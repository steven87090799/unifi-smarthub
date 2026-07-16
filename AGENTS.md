# SmartHub AI 工作入口

Node.js／Express 後端為 `server.js`，SPA 前端為 `public/index.html`；正式服務走 Docker，假資料服務為 `server-mock.js:3005`。

## 必守規則

- 先讀 `CONTEXT.md`；後端再讀 `SERVER-MAP.md`，前端再讀 `FRONTEND-MAP.md`。
- `server.js`、`public/index.html`、`data/`、`.env` 與低頻文件都採按需精準讀取。
- `.env` 含機密；先看 `.env.example`，必要時只檢查欄位是否存在，不回印值。
- 歷史資料使用 `db.js` 與 SQLite `data/smarthub.db`，不要恢復 JSON 整檔寫入。
- 前端可見 API／設定變更時，同步 `server-mock.js` 與對應測試。
- 修改前先看 `git status`；保留不相關變更，較大任務先建分支。
- 測試以受影響範圍為主；只有高風險或發布工作才跑完整 gate。

## 任務路由

| 任務 | 先讀 |
|---|---|
| 後端 API／排程／SQLite | `SERVER-MAP.md` |
| UI／圖表／輪詢 | `FRONTEND-MAP.md` |
| Docker／部署 | `README.md`、`docs/operations/` |
| UniFi／NAS／WiiM／UPS | `SERVER-MAP.md`、`docs/integrations/` 對應摘要 |
| 診斷／log／health | `docs/operations/OBSERVABILITY.md` |
| 全域架構 | `docs/ARCHITECTURE.md` |

重要實況：Docker UPS 使用 `UPS_SOURCE=ppb` 與 `host.docker.internal:3052`；`/health/ready` 檢查 SQLite／worker；活動頁資料更新為 3 秒。
