# SmartHub 資料更新頻率

前端只輪詢目前顯示的頁面；分頁隱藏或切到其他頁面後，該頁面的非共用工作會停止。所有一般前端工作採 `deviceActiveFrontendPollSec`，預設 5 秒；UPS 狀態、UPS 歷史與 PPB 事件使用獨立設定。歷史查詢仍和即時狀態分開，避免無限制重做大型 SQLite 查詢與 DOM 重繪。

## 前端目前頁面

| 頁面 | 工作 | 看著頁面時 |
|---|---|---:|
| 所有可見頁面 | 裝置焦點 heartbeat | 5 秒 |
| 所有可見頁面 | 重大事件橫幅 | 5 秒（預設） |
| 總覽 | UCG、客戶端、威脅、ISP、NAS、WiiM 即時資料 | 5 秒（預設） |
| 總覽 | 聚合趨勢圖 | 5 秒（預設） |
| 客戶端 | UniFi 活躍客戶端 | 5 秒（預設） |
| 資安 | 威脅與資安狀態 | 5 秒（預設） |
| UCG | 硬體、交換器/AP 埠、歷史與異常分析 | 5 秒（預設） |
| UCG | UniFi 裝置 snapshot 與 24 小時 history 顯示 | 5 秒（預設；不直接查設備） |
| NAS | 即時遙測、Docker、歷史、警報與休眠統計 | 5 秒（預設） |
| WiiM | 播放與系統狀態 | 5 秒（預設） |
| UPS | 真實來源狀態讀取 | 3 秒 |
| UPS | 歷史圖與事件 / PPB 原廠事件 | 10 秒 / 10 秒 |
| AdGuard | DNS 統計、查詢日誌與政策 | 5 秒（預設） |
| Linux | 即時 SSH 與歷史圖 | 5 秒（預設） |
| 雲端 | Site Manager / ISP | 5 秒（預設） |
| 通知 | 推播紀錄 | 5 秒（預設） |
| 設定 | 報表、系統診斷、資安設定 | 5 秒（預設） |
| WiFi、工具 | 背景輪詢 | 無；進頁或操作時讀取 |

一般前端工作共用可調整的 5 秒預設，並以 `applyPolling()` 防止同一工作重疊。若 Site Manager 的上游速率限制較低，應在設定與實作一併調整，不能只改文件宣稱不同頻率。

## 沒有觀看頁面時的後端取樣

| 後端工作 | 無人觀看 | 有人觀看相關頁面 |
|---|---:|---:|
| 聚合趨勢 | 600 秒（預設） | 5 秒（預設） |
| UCG 歷史 | 600 秒（預設） | 5 秒（預設） |
| UniFi 裝置 Controller／Device SSH 遙測 | 300 秒（預設） | 60 秒（UCG 頁可見；可設定） |
| NAS 歷史 | 600 秒（預設） | 5 秒（預設） |
| WiiM 溫度 | 600 秒（預設） | 5 秒（預設） |
| UPS 電壓、電池、負載與事件偵測 | 10 秒（可設定） | 3 秒真實讀取 |
| PPB 原廠事件同步 | 60 秒 | 10 秒 |
| Linux 歷史 | 600 秒（預設） | 5 秒（預設；SSH 快取約 4 秒） |
| 通知監看器 | 20 秒（可設定） | 相同 |
| 自動防禦 | 30 秒（可設定） | 相同 |
| 威脅 IP / AdGuard 政策 reconcile | 15 秒 | 相同 |
| 系統健康監視 | 30 秒（環境變數可設定） | 相同 |
| 排程報表 claim 掃描 | 60 秒 | 相同 |
| SQLite 一般遙測 flush | 10 分鐘（可設定；容量達上限會提前 flush） | 相同 |
| SQLite retention cleanup | 1 小時 | 相同 |

瀏覽器請求與裝置真實取樣是兩個不同層次。一般裝置在焦點模式下依 5 秒預設取得新資料，UPS 依獨立 3 秒設定真實讀取；所有數值均可由設定 API 調整。歷史圖與即時端點共用目前前端輪詢設定，但後端 collector 仍採單次執行完成後才排下一輪的模式。

## Scope 與 sampler 對應

| Heartbeat scope | 後端 sampler |
|---|---|
| `trend` | `trendHistory` |
| `ucg` | `ucgHistory` |
| `unifi-device-telemetry` | `unifiDeviceTelemetry` |
| `nas` | `nasHistory` |
| `wiim` | `wiimTemperature` |
| `ups` | `upsSample`, `ppbEventSync` |
| `linux` | `linuxHistory` |

總覽送出 `trend,ucg,nas,wiim,ups`；UCG 頁送出 `ucg,unifi-device-telemetry`，其他裝置頁只送自己的 scope。客戶端、資安與雲端頁只啟用 `trend`；設定、通知、WiFi、工具與 AdGuard 不會為設備 sampler 建立活動 scope。`general` 不屬於 sampler registry，不能無條件把所有設備切到高頻。

UniFi 裝置 API refresh 只讀 retained snapshot／SQLite，不重查 Controller、不建立 SSH、不寫 history、不發通知。Sampler 失敗時 snapshot 保留最後成功值並變成 stale；stale 樣本不寫入 history，也不推進高溫／恢復狀態機。

每個瀏覽器分頁有自己的 session lease。切頁或隱藏時以空 scope 釋放該分頁，不會清掉另一個可見分頁；沒有續約時租約自行過期。容量固定為最多 1,000 sessions、每 session 8 scopes，先清過期項目，再以最近最少使用順序淘汰。

頁面 focus 或已過期 scope 重新啟用時，只對匹配 scope 做一次 prompt sampling；一般 5 秒 heartbeat 只續租，不建立新 timer。設定值變更才會清除並重排全部 sampler，collector 完成後才安排下一次，因此 repeated rebuild 不重疊 collector。

受保護的 `/api/system/status` 只輸出聚合診斷：活動 session 數、active scopes、淘汰與過期清理數、sampler 狀態、SSH pool 與 PPB sync 摘要；不含 session ID、token 或 credential。
