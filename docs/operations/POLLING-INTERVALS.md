# SmartHub 資料更新頻率

一般設備與 UPS 使用不同的 Active／Idle 設定。設定頁儲存後會立刻重建既有 timer；舊 timer 會先清除，collector 完成後才安排下一次，因此不會重疊累積。

## 一般設備

預設值如下：

| 設定欄位 | 預設 | 實際控制內容 |
|---|---:|---|
| `deviceActiveFrontendPollSec` | 5 秒 | 可見 SmartHub 分頁向 API 更新畫面的間隔。|
| `deviceActiveBackendSampleSec` | 5 秒 | 有任一可見分頁時，後端一般 collector 的取樣與歷史寫入間隔。|
| `deviceIdleBackendSampleSec` | 600 秒 | 沒有可見分頁時，後端一般 collector 的背景取樣與歷史寫入間隔。|
| `heartbeatSec` | 5 秒 | 可見分頁回報仍在使用中的間隔；不等於取樣間隔。|
| `activeLeaseSec` | 30 秒 | 後端未收到 heartbeat 後，將該 session 視為離線的時間；必須大於 heartbeat。|

一般 collector 包含趨勢、UCG 背景 SSH 取樣、NAS、WiiM、Linux、UniFi clients／threats／設備 CPU 與溫度、ISP 與 AdGuard。collector 先更新 latest cache、寫入既有歷史資料，再由主要讀取 API 回傳 cache；只有 cache 不存在或已過期時，API 才會以 singleflight 補取一次。快取同時保存最後嘗試、最後成功、最後錯誤與連續失敗數；舊資料可供畫面顯示，但 watcher 會依失敗狀態判定離線，不會把舊資料當成健康。

## UPS

UPS 不使用一般設備的 600 秒 Idle 值，維持自己的獨立高頻設定：

| 設定欄位 | 預設 | 實際控制內容 |
|---|---:|---|
| `upsFrontendPollSec` | 3 秒 | UPS 頁面可見時的畫面更新。|
| `upsActiveBackendSampleSec` | 3 秒 | 有人瀏覽時 UPS 狀態與歷史取樣。|
| `upsIdleBackendSampleSec` | 10 秒 | 無人瀏覽時 UPS 狀態與歷史取樣。|
| `upsPpbEventActiveBackendSampleSec` | 10 秒 | 有人瀏覽時 PPB 原廠事件同步。|
| `upsPpbEventIdleBackendSampleSec` | 60 秒 | 無人瀏覽時 PPB 原廠事件同步。|

## 分頁與通知行為

只有 `document.visibilityState === 'visible'` 的分頁會送 heartbeat。hidden、關閉或 lease 到期後會停止一般前端輪詢，所有 session 都失效後後端切到 Idle；任一可見 session 存在則維持 Active。

通知 watcher 的掃描間隔仍由 `watcherSec` 控制，通常只掃描 collector snapshot，不自行以 20 秒週期重複查詢一般設備；尚無 cache 的首次讀取才透過與 API／collector 共用的 in-flight Promise 補取一次。notification sampler 會先更新所需快取。UPS 仍由獨立 sampler 維持高頻監控。

歷史清理保留最近 24 小時原始解析度，且只處理完整 bucket；更舊資料先壓縮為每分鐘一筆，必要時再壓縮為 5 分鐘與 1 小時資料後套用 hard cap。以 Active 5 秒、Idle 600 秒、保存 30 或 365 天計算，可避免 100,000 筆上限過早刪除資料，同時維持 SQLite 容量有界與既有圖表 response schema。
