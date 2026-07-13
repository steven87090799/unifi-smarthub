# 統計資料 JSON → SQLite 遷移評估

> 產生日期:2026-07-12。評估範圍:`data/` 下所有統計/歷史類 JSON 改用 SQLite 儲存。

> 實作狀態: 已於 `feature/sqlite-migration` 完成。實作入口為 `db.js`；首次啟動會匯入舊 JSON 並保留 `.migrated.bak`，前端 API 格式維持不變。實際依 Node 26 相容性採用 `better-sqlite3 12.x`（Docker Node 20 亦在支援範圍內）。本文的步驟圖保留作為設計與驗證依據。

---

## 一、現況盤點(要搬什麼、不搬什麼)

### ✅ 要搬(統計資料,共 9 個檔案)

| 檔案 | 記憶體變數 | 寫入模式 | 特殊性 |
|---|---|---|---|
| `trend-history.json` | `trendHistory` | 節流落盤 | 時間欄位 `t` (ISO 字串) |
| `ucg-history.json` | `ucgHistory` | 節流落盤 | 含 `cores` 陣列 |
| `nas-history.json` | `nasHistory` | 節流落盤 | 含 `disks` 巢狀物件、`fan_rpm` |
| `ups-history.json` | `upsHistory` | 節流落盤(斷電時強制每筆) | 量最大 (30s 一筆) |
| `wiim-history.json` | `wiimHistory` | 節流落盤 | **時間欄位是 `ts` (epoch 秒),與其他不同** |
| `linux-history.json` | `linuxHistory` | 節流落盤 | — |
| `ups-events.json` | `upsEvents` | **每筆立即寫** | newest-first + 就地改寫 `[0].end`(進行中事件) |
| `block-history.json` | 無(每次讀檔) | 每筆立即寫 | 上限 200 筆 |
| — | — | — | — |

### ❌ 不搬(設定類,留 JSON 就好)
`app-settings.json`、`security-settings.json`、`notification-settings.json`、`client-aliases.json` — 小、低頻、人類可讀方便除錯,搬進 DB 沒有效益。`ppb-i18n-zh.json` 是靜態語系檔,不動。

---

## 二、驅動選型(第一個決策點)

| 方案 | 優點 | 缺點 | 建議 |
|---|---|---|---|
| **better-sqlite3** ⭐ | 同步 API(跟現有程式風格一致)、成熟穩定、WAL 支援好 | 原生模組;Docker alpine 建置需 prebuild 或 `apk add python3 make g++` | **推薦**。x64(NAS N100/Mac)有 musl prebuild,通常免編譯 |
| `node:sqlite`(內建) | 零依賴、免編譯 | 需 Node ≥22.5;**Dockerfile 目前是 node:20-alpine,必須升級 base image**;API 較新較少實戰 | 備選。若順便想升 Node 24 可考慮 |
| `sql.js` (WASM) | 免編譯 | 全 DB 載入記憶體、要手動落盤 = 回到 JSON 老問題 | ✕ 不要 |

---

## 三、Schema 設計(關鍵決策:通用表 + JSON payload)

六個 history 系列欄位差異大(nas 有巢狀 `disks`、ucg 有 `cores` 陣列),**不建議每系列一張強型別表**——欄位以後還會加(這專案加欄位的頻率很高)。用一張通用表:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS history (
  id     INTEGER PRIMARY KEY,          -- 避免同毫秒撞鍵
  series TEXT    NOT NULL,             -- 'trend'|'ucg'|'nas'|'ups'|'wiim'|'linux'
  ts     INTEGER NOT NULL,             -- epoch 毫秒 (統一!)
  data   TEXT    NOT NULL              -- 該點完整 JSON (不含時間欄位)
);
CREATE INDEX IF NOT EXISTS idx_history ON history(series, ts);

CREATE TABLE IF NOT EXISTS ups_events (
  id INTEGER PRIMARY KEY,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER,                      -- NULL = 斷電進行中
  duration_sec INTEGER,
  min_battery REAL,
  start_voltage REAL
);

CREATE TABLE IF NOT EXISTS block_history (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  mac TEXT, name TEXT, action TEXT, source TEXT, reason TEXT
);
```

查詢永遠是「某系列 + 時間範圍」,`(series, ts)` 索引完美命中;`json_extract()` 需要時也能查 payload 內欄位。

---

## 四、架構會動哪些地方

```
server.js 內會被取代的機制:
├─ registerFlushable / flushOne / flushAllHistories   → 整段刪除 (9 處 markDirty)
├─ pruneHistory()                                     → DB 端定期 DELETE (7 處呼叫)
├─ sliceSince(arr, cutoff)                            → db.getSince(series, cutoff) (10 處)
├─ 各系列啟動時 JSON.parse(readFileSync)               → 一次性匯入 + 啟動免載入
├─ upsEvents unshift/[0] 就地改寫                      → UPDATE ups_events WHERE end_ts IS NULL
├─ loadBlockHistory / appendBlockHistory              → SELECT / INSERT
└─ SIGTERM/SIGINT flushAll                            → db.close() (WAL checkpoint)

新增檔案:
└─ db.js (~150 行):開庫+schema、insertPoint、getSince、events/block CRUD、
                    JSON 一次性匯入、每小時保留天數清理、close

其他:
├─ package.json     +better-sqlite3
├─ Dockerfile       build 保險 (apk add python3 make g++ 於 npm ci 前,或多階段)
├─ 設定頁            historyFlushMin 語意改變 (見下方坑 #4) 或移除
└─ CLAUDE.md/README 持久化章節改寫
```

**前端完全不動**:所有 `/api/*/history` 回傳格式維持原樣(`t` ISO 字串 / wiim 的 `ts` 秒),由後端在 DB 邊界做轉換。

---

## 五、步驟圖(建議執行順序)

```
┌─ Phase 0:準備 ───────────────────────────────────────────┐
│ 0.1 開 feature/sqlite-migration 分支                       │
│ 0.2 npm i better-sqlite3;本機 + Docker build 各驗證一次    │
│     (先確認 alpine musl prebuild 可用,不行就加編譯依賴)     │
└──────────────────────────┬────────────────────────────────┘
                           ▼
┌─ Phase 1:db.js 基礎層 ───────────────────────────────────┐
│ 1.1 建 db.js:開庫 (DATA_DIR/smarthub.db)、WAL、schema      │
│ 1.2 寫 insertPoint / getSince / 事件與封鎖 CRUD             │
│ 1.3 寫 migrateFromJson():逐檔匯入 (單一 transaction),      │
│     成功後改名 *.json → *.json.migrated.bak (不刪除!)      │
└──────────────────────────┬────────────────────────────────┘
                           ▼
┌─ Phase 2:逐系列切換 (每切一個就測一個) ─────────────────────┐
│ 2.1 trend  → 改 sampleTrends 寫入 + /api/history 讀取       │
│ 2.2 ucg / nas / linux / wiim (注意 wiim ts 秒→毫秒轉換)     │
│ 2.3 ups history (斷電強制寫的邏輯直接消失——每筆本來就落盤)   │
│ 2.4 ups events (改用 open-event UPDATE;重啟接續邏輯改查     │
│     end_ts IS NULL)                                        │
│ 2.5 block history                                          │
└──────────────────────────┬────────────────────────────────┘
                           ▼
┌─ Phase 3:拆舊機制 ───────────────────────────────────────┐
│ 3.1 刪 registerFlushable/pruneHistory/sliceSince(陣列版)    │
│ 3.2 SIGTERM/SIGINT 改 db.close()                           │
│ 3.3 新增每小時保留清理:DELETE WHERE ts < now-keepDays       │
│     + PRAGMA incremental_vacuum                            │
└──────────────────────────┬────────────────────────────────┘
                           ▼
┌─ Phase 4:驗證 (全部通過才合併) ───────────────────────────┐
│ 4.1 舊 data/ 複本啟動 → 確認匯入筆數 = JSON 筆數            │
│ 4.2 前端每頁圖表逐一比對 (範圍切換/CSV 匯出/斷電事件表)      │
│ 4.3 kill -9 硬殺測試 → 重啟資料不丟 (WAL 恢復)              │
│ 4.4 Docker build + 容器內跑 (volume 上的 DB 檔權限)         │
│ 4.5 模擬斷電事件跨重啟接續                                  │
└──────────────────────────┬────────────────────────────────┘
                           ▼
                     合併 main + 部署
```

---

## 六、預防的坑(按踩到的機率排序)

1. **時間格式不一致(最容易出 bug)**:現有 5 個系列用 `t`(ISO 字串)、wiim 用 `ts`(epoch 秒)。DB 統一存 epoch 毫秒,但 API 回應必須轉回原格式,否則前端所有圖表的時間軸直接壞掉。每切一個系列就開頁面比對一次。
2. **Docker 原生模組**:better-sqlite3 在 alpine(musl)上,x64 有 prebuild 但不保證每版都有;Dockerfile 要嘛加 `apk add --no-cache --virtual .build python3 make g++` 再 `npm ci` 後 `apk del .build`,要嘛換 debian-slim base。**先在本機 build 一次 Docker 映像再開始寫程式**,避免寫完才發現編不過。
3. **ups-events 的就地改寫模式**:現在是 `upsEvents.unshift(...)` + 直接改 `upsEvents[0].end`,還有「重啟時檢查 `[0]` 未結束就接續」的邏輯。改成 DB 後要用 `WHERE end_ts IS NULL` 找進行中事件,漏改任何一處都會出現重複/斷裂的斷電紀錄。
4. **磁碟寫入頻率變高**:JSON 時代是 30 分鐘寫一次大檔,SQLite 是每筆樣本一次小寫入(WAL append)。對 SSD 完全沒問題,但如果 `data/` volume 在機械碟上會**妨礙硬碟休眠**。對策:DB 放系統碟(UGREEN 預設 docker volume 在系統 SSD 即可);若真的需要,再把 `historyFlushMin` 重新利用為「批次 transaction 間隔」(記憶體暫存 + 定時批次寫)——但先不要做,不要為了不存在的問題加複雜度。
5. **保留清理殘留空間**:`DELETE` 不會縮小檔案。開庫時設 `PRAGMA auto_vacuum = INCREMENTAL`(必須在建表前!),清理後跑 `PRAGMA incremental_vacuum`。
6. **匯入只能跑一次**:啟動匯入要判斷「該系列 DB 已有資料就跳過」,且舊檔改名 `.migrated.bak` 保留而不是刪除——這是你的回滾保險,穩定跑兩週後再手動刪。
7. **`/api/ups/csv` 與報表**:`buildReport` 裡 `sliceSince(upsHistory...)`、`sliceSince(linuxHistory...)` 等 10 處讀取要一起改,漏掉會 ReferenceError(變數已刪)。用 `grep -n "History\b" server.js` 全面掃一次。
8. **兩個伺服器同時開庫**:port 3000 正式 + 3005 mock 同時跑;mock 無持久化不會碰 DB,但**之後寫任何維運腳本不要直接開同一個 DB 檔寫入**(busy_timeout 有設但仍應避免)。
9. **備份方式改變**:JSON 時代複製檔案即備份;SQLite 要連 `-wal` 檔一起複製,或用 `VACUUM INTO 'backup.db'`。README 的備份章節要更新。

---

## 七、效益確認(為什麼值得做)

- **寫入成本**:UPS 每 30 秒重寫 ~2MB JSON → 每 30 秒 append 一行(~100 bytes),寫入放大降低 4 個數量級
- **啟動記憶體**:不再把 30 天 × 6 系列全部載入記憶體(目前上限情境約 50 萬點),常駐記憶體大幅下降
- **查詢**:範圍查詢走索引,不再全陣列掃描;未來可做「任意區間聚合」(如報表要月平均)只是一句 SQL
- **資料安全**:WAL 讓 kill -9 / 斷電後自動恢復到最後一筆完整 transaction,不再有「最壞損失 30 分鐘」的窗口
