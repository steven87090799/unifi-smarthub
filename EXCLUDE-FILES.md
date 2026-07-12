# SmartHub Context Exclusion List

這份文件說明哪些檔案「預設不要進 AI 上下文」。這不是封鎖讀取；必要時仍可用 `rg`/`sed` 精準讀小片段。

## 應排除

| 路徑 | 原因 | 何時才讀 |
|---|---|---|
| `.env`, `.env.*` | 含密碼、API key、token、內網位置 | 實機連線 debug，且只讀必要欄位 |
| `node_modules/` | 依賴原始碼巨大且低價值 | 幾乎不讀 |
| `package-lock.json` | lockfile 內容長 | 只有 dependency/安全性問題 |
| `data/` | 歷史資料與 runtime 狀態，最大檔超過 1 MB | 只抽樣資料 schema 或異常紀錄 |
| `public/index.html` | 533 KB / 7367 行巨型 SPA | 前端 UI/JS/CSS 任務，且切片讀 |
| `server-mock.js` | mock 後端，非正式服務 | mock 行為或開發模式問題 |
| `ppb-i18n-zh.json` | PowerPanel 翻譯資料 | PPB 事件文字對照 |
| `unifi-network-api.md` | UniFi 上游規格 | 修改/驗證 UniFi API 行為 |
| `ugreen-nas-api.md` | UGREEN NAS 上游規格 | 修改/驗證 NAS API 行為 |
| `wiim_spec.md`, `wiim-amp-api.md` | WiiM 上游規格 | 修改/驗證 WiiM 指令 |
| `cyberpower-ups-api.md` | UPS/PPB/NUT 參考 | 修改/驗證 UPS 接入 |
| `ROADMAP.md`, `SQLITE-MIGRATION.md` | 規劃文件 | 路線圖或資料庫遷移任務 |
| `.git/` | Git 內部資料 | 不直接讀 |
| `*.log` | runtime 輸出，可能很長 | debug 時讀尾端或搜尋關鍵字 |

## 可安全先讀

| 路徑 | 用途 |
|---|---|
| `CONTEXT.md` | 低 token 入口 |
| `SERVER-MAP.md` | 後端索引 |
| `FRONTEND-MAP.md` | 前端索引 |
| `AGENTS.md` | 架構與 AI 操作規範 |
| `README.md` | 部署與維運 |
| `spec.md` | 技術規格與 endpoint 全貌 |
| `.env.example` | 設定欄位參考，不含真實密碼 |

## 關於 `.env`

`.env` 應該排除，因為它常含：

- UniFi/NAS/PPB/Telegram/Discord 密碼或 token
- 內網 IP、port、帳號
- Webhook URL

排除後仍可以 debug：

- 先讀 `.env.example` 了解應有欄位。
- 若要確認設定是否存在，用 `rg -n '^NAS_HOST=|^NAS_USER=' .env` 這種精準搜尋。
- 若問題與密碼/token 有關，請使用者提供遮罩版，或只在必要時讀單一欄位並避免在回覆中重印。

## 建議 ignore 檔

本專案已提供：

- `.claudeignore`
- `.codexignore`
- `.gitignore`
- `.dockerignore`

`.claudeignore` / `.codexignore` 只用來降低預設上下文成本；不代表工具永遠不能讀該檔。
