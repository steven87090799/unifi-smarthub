# SmartHub Context Guide

目標：每次對話只送入任務所需的最小內容。`AGENTS.md` 是唯一常駐工作規則；本檔是唯一預設閱讀文件。

## 讀取分級

| 分級 | 檔案 | 使用時機 |
|---|---|---|
| 常駐 | `AGENTS.md` | 工具/安全/讀檔規則；已壓縮為短入口 |
| 預設 | `CONTEXT.md` | 每次任務先讀本檔 |
| 任務索引 | `SERVER-MAP.md`, `FRONTEND-MAP.md` | 分別處理後端或前端才讀 |
| 條件文件 | `README.md`, `.env.example`, `OBSERVABILITY.md`, `REVIEW-TODO.md` | 部署、設定、診斷、待辦才讀 |
| Lazy-read | 程式大檔、規格、規劃、runtime 資料 | 先搜尋符號，再讀小片段 |

## 任務路線

| 任務 | 先讀 | 接著精準讀 |
|---|---|---|
| 後端 API／排程／SQLite | `SERVER-MAP.md` | `server.js`、`db.js` 相關符號 |
| UI／圖表／輪詢 | `FRONTEND-MAP.md` | `public/index.html` 的 section/function |
| Docker／部署 | `README.md` | `docker-compose.yml`、`Dockerfile`、`.env.example` |
| 裝置整合 | `SERVER-MAP.md` | 對應 API 規格與後端局部 |
| 診斷 | `OBSERVABILITY.md` | `observability/`、相關 route 局部 |

## 預設排除（必要時可精準讀）

- 大型程式：`server.js`、`public/index.html`、`server-mock.js`、`db.js`。
- runtime／機密：`data/`、`.env`、`*.log`。
- 依賴／產物：`node_modules/`、`package-lock.json`、`.git/`。
- 低頻文件：`spec.md`、`ROADMAP.md`、`*-api.md`、`*_spec.md`、`OBSERVABILITY.md`、`REVIEW-TODO.md`。

完整清單與例外見 `EXCLUDE-FILES.md`。排除是「預設不送入」，不是禁止 debug；先用 `rg` 找符號或欄位，再用 `sed -n` 讀窄範圍。
