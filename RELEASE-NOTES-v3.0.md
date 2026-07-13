# SmartHub v3.0 Release Notes

發布日期：2026-07-14

SmartHub v3.0 將通知中心、每日營運報表與即時總覽更新整合成完整的家庭基礎設施監控版本。這個版本著重於「有事情時能立即知道」，同時保留每一種事件的獨立開關，避免不需要的推播。

## 重點更新

### 56 種可自由選擇的推播條件

- 每一個事件都能獨立勾選或取消，不會強制開啟完整告警集合。
- 新設備通知會等待 UniFi 取得有效 IP 後才發送，不再顯示「IP 取得中」。
- 新增設備 IP 變更、WiFi 弱訊號、SSID 啟停、UniFi 設備離線與韌體更新、Site Manager 雲端離線、WAN 高延遲等網路事件。
- 新增 NAS CPU、記憶體、容量、硬碟健康與 API 離線告警。
- 新增 UPS 高負載、低續航、電壓異常、資料來源切換與所有來源失聯／恢復通知。
- 新增 WiiM 離線、溫度與高音量，AdGuard 保護狀態、離線與高攔截率，以及 Linux 主機離線、溫度、磁碟、CPU、記憶體與 load average 告警。
- 新增 Docker 容器停止／恢復、健康檢查、重新啟動、新增／移除、OOM Kill、CPU／記憶體與分級 Log 告警。
- 新增 SmartHub 系統 critical、warning、恢復與服務啟動通知。

所有高頻門檻事件均有冷卻時間或狀態轉換去重；首次掃描只建立基準，不會在服務啟動時把既有事件一次全部推送。

### 每日報表強化

- 每日播報預設開啟，仍可調整時間與週期。
- 報表內容重新分段，降低資訊混雜感。
- 增加 Docker 容器狀態、資源用量與近期重要 Log 摘要。
- 增加 SmartHub System Diagnostics、SQLite、背景工作與服務健康摘要。
- 保留報表執行紀錄與傳送結果，方便確認是否成功送達。

### 總覽與圖表更新

- Hero 圖表改以真實歷史資料初始化，避免空白或跳動的假資料。
- 統一折線圖 reveal 動畫與數值更新節奏。
- 使用者正在查看總覽或裝置頁時，相關資料與後端取樣會聚焦為 3 秒更新；切頁後立即釋放上一頁 scope。
- 優化安全評分版面、趨勢連續性與圖表互動提示。

### 維運與開發體驗

- 通知設定 API 與 `server-mock.js` 保持相同欄位，可在無設備環境完整測試設定儲存。
- 精簡 AI 工作入口文件，改由 `CONTEXT.md`、`SERVER-MAP.md`、`FRONTEND-MAP.md` 與 `OBSERVABILITY.md` 分流讀取。
- SQLite migration 已完成，因此移除過期的遷移操作文件；既有 `data/smarthub.db` 與設定檔維持相容。

## 升級方式

升級前先備份 `.env` 與持久化資料卷：

```bash
git fetch --tags
git checkout v3.0
docker compose up -d --build --force-recreate
docker compose ps
docker compose logs --tail=100 unifi-smarthub
```

升級後建議進入「通知推播」逐項確認新增條件與門檻。Docker 告警需要設定 NAS Monitor；其他設備告警只會在對應整合已設定時執行監測。

## 相容性與注意事項

- Node.js 20+。
- Docker 為正式部署方式；UPS 在 Docker 中建議使用已驗證的 PowerPanel Business REST 路徑：`UPS_SOURCE=ppb`、`PPB_HOST=host.docker.internal`、PPB HTTP discovery port `3052`。
- 既有通知管道、SQLite 歷史資料與 JSON 設定會沿用；新增通知欄位以安全預設值補齊。
- 本版本沒有資料庫破壞性遷移。

## 驗證清單

- Node.js 語法檢查。
- 完整 `npm test` 測試套件。
- 通知設定在正式 API 與 mock API 的欄位一致性。
- Docker Compose 設定解析與容器健康端點檢查。
