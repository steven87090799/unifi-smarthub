# SmartHub 資料更新頻率

前端只輪詢目前顯示的頁面；分頁隱藏或切到其他頁面後，該頁面的非共用工作會停止。裝置頁的「即時資料」採 3 秒更新，歷史查詢與外部雲端 API 依成本保留較低頻率。

## 前端目前頁面

| 頁面 | 工作 | 看著頁面時 |
|---|---|---:|
| 所有可見頁面 | 裝置焦點 heartbeat | 5 秒 |
| 所有可見頁面 | 重大事件橫幅 | 10 秒 |
| 總覽 | UCG、客戶端、威脅、ISP、NAS、WiiM、UPS 即時資料 | 3 秒 |
| 總覽 | 聚合趨勢圖 | 10 秒 |
| 客戶端 | UniFi 活躍客戶端 | 3 秒 |
| 資安 | 威脅與資安狀態 | 3 秒 |
| UCG | 硬體與交換器/AP 埠狀態 | 3 秒 |
| UCG | 歷史圖 / 7 天異常分析 | 10 秒 / 60 秒 |
| NAS | 即時遙測與 Docker | 3 秒 |
| NAS | 歷史、警報與休眠統計 | 10 秒 |
| WiiM | 播放與系統狀態 | 3 秒 |
| UPS | 真實來源狀態讀取 | 3 秒 |
| UPS | 歷史圖與事件 / PPB 原廠事件 | 10 秒 / 10 秒 |
| AdGuard | DNS 統計、查詢日誌與政策 | 3 秒 |
| Linux | 即時 SSH 與歷史圖 | 3 秒 |
| 雲端 | Site Manager / ISP | 120 秒 / 60 秒 |
| 通知 | 推播紀錄 | 30 秒 |
| 設定 | 報表、系統診斷、資安設定 | 30 秒 |
| WiFi、工具 | 背景輪詢 | 無；進頁或操作時讀取 |

Site Manager 沒有改成 3 秒，因為單次雲端更新會呼叫多個官方端點；3 秒週期會貼近官方速率上限，反而容易造成 429 與資料中斷。

## 沒有觀看頁面時的後端取樣

| 後端工作 | 無人觀看 | 有人觀看相關頁面 |
|---|---:|---:|
| 聚合趨勢 | 1,800 秒（可設定） | 3 秒 |
| UCG 歷史 | 由請求/監看工作帶動，快取 15 秒 | 3 秒，快取 2 秒 |
| NAS 歷史 | 900 秒 | 3 秒 |
| WiiM 溫度 | 1,800 秒（沿用趨勢閒置設定） | 3 秒 |
| UPS 電壓、電池、負載與事件偵測 | 10 秒（可設定） | 3 秒真實讀取 |
| PPB 原廠事件同步 | 60 秒 | 10 秒 |
| Linux 歷史 | 900 秒 | 3 秒，SSH 快取 2 秒 |
| 通知監看器 | 20 秒（可設定） | 相同 |
| 自動防禦 | 30 秒（可設定） | 相同 |
| 威脅 IP / AdGuard 政策 reconcile | 15 秒 | 相同 |
| 系統健康監視 | 30 秒（環境變數可設定） | 相同 |
| 排程報表 claim 掃描 | 60 秒 | 相同 |
| SQLite 一般遙測 flush | 10 分鐘（可設定；容量達上限會提前 flush） | 相同 |
| SQLite retention cleanup | 1 小時 | 相同 |

瀏覽器的 3 秒請求與裝置真實取樣是兩個不同層次。UPS、UCG、NAS、WiiM、AdGuard 與 Linux 的即時端點在焦點模式下會取得新資料；歷史圖仍使用較低頻率，避免每 3 秒重做大型 SQLite 查詢與 DOM 重繪。

## Scope 與 sampler 對應

| Heartbeat scope | 後端 sampler |
|---|---|
| `trend` | `trendHistory` |
| `ucg` | `ucgHistory` |
| `nas` | `nasHistory` |
| `wiim` | `wiimTemperature` |
| `ups` | `upsSample`, `ppbEventSync` |
| `linux` | `linuxHistory` |

總覽送出 `trend,ucg,nas,wiim,ups`；各裝置頁只送自己的 scope。客戶端、資安與雲端頁只啟用 `trend`；設定、通知、WiFi、工具與 AdGuard 不會為設備 sampler 建立活動 scope。`general` 不屬於 sampler registry，不能無條件把所有設備切到 3 秒。

每個瀏覽器分頁有自己的 session lease。切頁或隱藏時以空 scope 釋放該分頁，不會清掉另一個可見分頁；沒有續約時租約自行過期。容量固定為最多 1,000 sessions、每 session 8 scopes，先清過期項目，再以最近最少使用順序淘汰。

頁面 focus 或已過期 scope 重新啟用時，只對匹配 scope 做一次 prompt sampling；一般 5 秒 heartbeat 只續租，不建立新 timer。設定值變更才會清除並重排全部 sampler，collector 完成後才安排下一次，因此 repeated rebuild 不重疊 collector。

受保護的 `/api/system/status` 只輸出聚合診斷：活動 session 數、active scopes、淘汰與過期清理數、sampler 狀態、SSH pool 與 PPB sync 摘要；不含 session ID、token 或 credential。
