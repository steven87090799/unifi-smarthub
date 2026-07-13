# SmartHub AI Context Guide

這份文件是給 AI/開發者的「低 token 入口」。先讀這裡，再決定要不要讀大檔。

## 先讀順序

1. 一般任務：讀本檔即可判斷下一步。
2. 後端任務：讀 `SERVER-MAP.md`，再用 `rg` 找 `server.js` 相關區段。
3. 前端任務：讀 `FRONTEND-MAP.md`，再用 `rg` 找 `public/index.html` 相關區段。
4. 部署/使用者操作：讀 `README.md`。
5. 架構/API 全貌：讀 `AGENTS.md` 或 `spec.md`。
6. 未來功能規劃：讀 `ROADMAP.md`。

## 預設不要讀

完整清單見 `EXCLUDE-FILES.md`。重點是：

- `public/index.html` 很大，只在 UI/前端 JS/CSS 任務讀片段。
- `data/*.json` 是歷史資料，通常不提供結構知識。
- `.env` 含密碼、token、內網 IP；除非 debug 必要，不應自動載入上下文。
- `*-api.md` / `*_spec.md` 是上游 API 參考；只有對應整合需要查規格時才讀。
- `node_modules/`、`package-lock.json`、`.git/` 不需要預設讀。

## 常見任務讀檔路線

| 任務 | 先讀 | 必要時再讀 |
|---|---|---|
| 新增/修後端 API | `SERVER-MAP.md` | `server.js` 相關 endpoint 區段 |
| 修 UI、圖表、輪詢 | `FRONTEND-MAP.md` | `public/index.html` 相關 section/function |
| 修 Docker/部署 | `README.md`, `docker-compose.yml`, `Dockerfile` | `.env.example` |
| 修 NAS/UniFi/WiiM/UPS 串接 | `SERVER-MAP.md` | 對應 `*-api.md` / `*_spec.md` |
| Debug 實機連線 | `SERVER-MAP.md`, `.env.example` | 只檢查 `.env` 的必要欄位或請使用者提供遮罩值 |
| 調整歷史資料策略 | `SQLITE-MIGRATION.md`, `SERVER-MAP.md` | 只抽樣 `data/*.json` 的前幾行或欄位 |

## `.env` 原則

排除 `.env` 不是表示永遠不能 debug，而是避免密碼/token 每次自動進上下文。

需要 debug 時優先做這幾件事：

- 看 `.env.example` 確認欄位名稱。
- 用 `rg '^FIELD=' .env` 或只讀特定欄位是否存在。
- 需要看值時，盡量只看遮罩後的值、host/port 類低敏資訊，密碼/token 由使用者確認後再處理。

## 精準讀檔範例

```bash
rg -n "app.get\\('/api/ups/status'|readUpsLive|sampleUps" server.js
sed -n '2390,2668p' server.js

rg -n "page-ups|fetchUps|initUpsCharts|POLL_JOBS" public/index.html
sed -n '3554,3660p' public/index.html
```

## 壓縮上下文原則

- 優先用本檔、`SERVER-MAP.md`、`FRONTEND-MAP.md` 這類索引，不把大檔全文送進上下文。
- 用 `rg` 找符號、endpoint、id、function 名，再用 `sed -n` 讀附近小區段。
- API 規格、Roadmap、SQLite 遷移文件都採 lazy-read：任務沒碰到就不讀。
- 不用刻意把內容壓成難懂代碼；過度壓縮會增加誤解成本。最佳做法是短表格、固定縮寫、精準行號。
