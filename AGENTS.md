# SmartHub — AI 工作入口

Node.js + Express 後端（`server.js`）與單頁前端（`public/index.html`）的家用網路管理面板；正式服務走 Docker，開發 mock 是 `server-mock.js`（port 3005）。

## 必守規則

- 先讀 `CONTEXT.md`；後端再讀 `SERVER-MAP.md`，前端再讀 `FRONTEND-MAP.md`，最後只用 `rg`/`sed` 讀相關程式片段。
- 不要預讀 `server.js`、`public/index.html`、`data/`、`.env`、API 規格或 `spec.md`。它們都是按任務精準讀取的 lazy-read 檔案。
- `.env` 含機密；先看 `.env.example`，debug 時只檢查必要欄位且不回印敏感值。
- 歷史資料使用 SQLite `data/smarthub.db`；新增歷史資料請使用 `db.js` 的既有介面，不要重新引入 JSON 整檔寫入。
- 前端可見 endpoint 或設定變更時，同步 `server-mock.js` 並跑對應 smoke test／`npm test`。
- 修改功能前先看 `git status`；保留不相關的既有變更。功能規模足夠時先建分支，完成後交付可執行的一致狀態。

## 任務路由

| 任務 | 讀取順序 |
|---|---|
| 後端 API、排程、SQLite | `SERVER-MAP.md` → `server.js` / `db.js` 局部 |
| UI、圖表、輪詢 | `FRONTEND-MAP.md` → `public/index.html` 局部 |
| Docker、部署 | `README.md` → `docker-compose.yml` / `Dockerfile` |
| UniFi、NAS、WiiM、UPS 串接 | `SERVER-MAP.md` → 對應 API 規格 |
| 診斷、log、health | `OBSERVABILITY.md` → `observability/` 局部 |

## 目前重要實作事實

- Docker health：`/health`（liveness）、`/health/ready`（SQLite/worker）、`/api/system/status`（完整診斷，受驗證保護）。
- 前端以活動 scope 讓總覽／裝置頁走 3 秒更新；UPS 取樣獨立於瀏覽狀態。
- Docker UPS 已驗證的路徑是 PPB REST（`UPS_SOURCE=ppb`，透過 `host.docker.internal:3052`）；不要改用容器內 `pwrstat`。

歷史架構背景與早期 API 參考在 `spec.md`；live contract 先查 maps、共用 policy/route modules 與 tests，必要時再精準讀 source。
