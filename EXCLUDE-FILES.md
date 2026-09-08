# SmartHub 預設排除清單

這些路徑預設不進 AI 上下文；任務需要時仍可先搜尋再窄範圍讀取。

| 路徑 | 原因 | 何時讀 |
|---|---|---|
| `.env`, `.env.*` | 機密 | 實機連線除錯，且只檢查必要欄位 |
| `data/` | SQLite、設定與 runtime 歷史 | 儲存、遷移或資料異常 |
| `node_modules/`, `package-lock.json` | 體積大 | 依賴或安全問題 |
| `server.js`, `public/index.html`, `public/js/app.js` | 大型主檔 | 先讀對應 map，再切片 |
| `server-mock.js`, `db.js`, `observability/` | 低頻實作 | mock、SQLite、診斷任務 |
| `docs/integrations/` | 整合參考 | 修改對應設備 |
| `docs/operations/` | 維運文件 | 部署、發布、診斷 |
| `docs/planning/` | 規劃 | roadmap／backlog |
| `docs/reports/` | 歷史證據 | 發布或稽核 |
| `SMARTHUB_COMPLETE_OPERATION_MANUAL_ZH_TW.html` | 完整操作手冊，內容大且低頻 | 人類查閱或指定章節 |
| `docs/reference/architecture.md` | 全域架構 | 跨模組設計 |
| `.git/`, `*.log`, `.DS_Store` | 工具／系統雜訊 | 通常不讀 |

## 可先讀（依序）

- `CLAUDE.md`：唯一 AI 初始入口與任務分流表
- `AGENTS.md`：repository 必守規則
- `CONTEXT.md`：低上下文路由
- `docs/reference/backend-map.md`
- `docs/reference/frontend-map.md`
- 任務涉及部署時才讀 `README.md`
- 欄位參考使用 `.env.example`，不要先讀真實 `.env`

`.codexignore` 與 `.claudeignore` 應維持同一套預設排除方向。

## 上下文預算

- 超過 100 KiB 的 tracked 檔案預設不得整檔讀取；先用索引與 `rg` 定位，再用行號切片。
- Source 或文件一次以不超過 400 行為原則；搜尋命中超過 50 行時先縮小 pattern。
