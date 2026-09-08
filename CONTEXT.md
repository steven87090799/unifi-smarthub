# SmartHub 低上下文入口

目標：每次只讀完成任務需要的最少內容。AI 初始先讀根目錄 `CLAUDE.md`，再讀本檔；本檔的連結是分流索引，不代表要把所有文件一起讀入。

## 讀取順序

| 任務 | 入口 | 接著讀 |
|---|---|---|
| 一般任務 | `CONTEXT.md` | 依下列分類只選一份索引 |
| 後端／SQLite | `docs/reference/backend-map.md` | 用 `rg` 找 symbol 後精準讀 `server.js`、`server/`、`db.js`、test |
| 前端／輪詢 | `docs/reference/frontend-map.md` | 用 `rg` 找 section／函式後精準讀 `public/index.html`、`public/js/`、frontend test |
| 部署／Docker | `README.md` | `docs/operations/`、Compose、Dockerfile |
| 整合 | `docs/reference/backend-map.md` | `docs/integrations/` 對應摘要與相關 source |
| 診斷 | `docs/operations/OBSERVABILITY.md` | `observability/` 與相關 route |
| 規劃 | `docs/planning/` | 只讀尚未完成項目 |

## 最小操作順序

1. `git status --short --branch`。
2. 依上表選一條路徑；不要預讀整個 repository。
3. `rg -n` 搜尋 route、symbol、section、設定或錯誤，再用 `sed -n` 讀命中區段。
4. 修改後只跑受影響檢查；發布／高風險任務才讀完整 release checklist。
5. 回報 source、local、Hosted CI 與真實環境證據的邊界；舊 report 不等於目前 head。

預設上下文預算：超過 100 KiB 的 tracked 檔案不整檔讀取；source／文件一次最多讀約 400 行；搜尋命中超過 50 行時先縮小搜尋條件。

## 預設不讀

- 機密／runtime：`.env`、`data/`、`*.log`。
- 依賴／產物：`node_modules/`、`package-lock.json`、`.git/`。
- 大型程式：`server.js`、`public/index.html`、`public/js/app.js`、`server-mock.js`、`db.js`。
- 低頻內容：`docs/integrations/`、`docs/reports/`、`docs/planning/`、`docs/reference/architecture.md`、`SMARTHUB_COMPLETE_OPERATION_MANUAL_ZH_TW.html`。

排除只代表預設不送入上下文，不是禁止除錯。完整規則見 `EXCLUDE-FILES.md` 與 `CLAUDE.md`；完整文件導航見 `SMARTHUB_COMPLETE_OPERATION_MANUAL_ZH_TW.html`。
