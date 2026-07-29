# SmartHub 低上下文入口

目標：每次只讀完成任務需要的最少內容。

## 讀取順序

| 任務 | 入口 | 接著讀 |
|---|---|---|
| 一般任務 | `CONTEXT.md` | 依下列分類選一份索引 |
| 後端／SQLite | `docs/reference/backend-map.md` | 精準讀 `server.js`、`server/`、`db.js` |
| 前端／輪詢 | `docs/reference/frontend-map.md` | 精準讀 `public/index.html`、`public/js/` |
| 部署／Docker | `README.md` | `docs/operations/`、Compose、Dockerfile |
| 整合 | `docs/reference/backend-map.md` | `docs/integrations/` 對應摘要與相關 source |
| 診斷 | `docs/operations/OBSERVABILITY.md` | `observability/` 與相關 route |
| 規劃 | `docs/planning/` | 只讀尚未完成項目 |

## 預設不讀

- 機密／runtime：`.env`、`data/`、`*.log`。
- 依賴／產物：`node_modules/`、`package-lock.json`、`.git/`。
- 大型程式：`server.js`、`public/index.html`、`server-mock.js`、`db.js`。
- 低頻內容：`docs/integrations/`、`docs/reports/`、`docs/planning/`、`docs/reference/architecture.md`。

排除只代表預設不送入上下文，不是禁止除錯。完整規則見 `EXCLUDE-FILES.md`；完整文件導航見 `SMARTHUB_COMPLETE_OPERATION_MANUAL_ZH_TW.html`。
