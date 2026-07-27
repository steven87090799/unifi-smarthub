# CyberPower UPS 整合摘要

SmartHub 支援 PPB、NUT、`pwrstat`、`pmset` 四種來源。Docker 已驗證路徑是 PowerPanel Business REST。

## 來源順序

```env
UPS_SOURCE=auto
```

`auto` 依序嘗試：

1. `ppb`
2. `nut`
3. `pwrstat`
4. `pmset`

指定來源失敗時仍會回退其他來源，並在狀態中回報 `actualSource`。

## Docker 建議：PPB REST

```env
UPS_SOURCE=ppb
PPB_HOST=host.docker.internal
PPB_PORT=3052
PPB_USER=...
PPB_PASSWORD=...
```

流程：

1. 對 `http://<host>:3052/local/` 探索實際 HTTPS port。
2. 呼叫 `/local/rest/v1/login/verify` 取得 token。
3. 讀取 `/local/rest/v1/ups/status` 與事件 API。
4. 401／403 時重新登入一次；服務重啟後重新探索 port。

PPB 的本機 HTTPS 使用設備自簽憑證，程式目前不驗證 CA；只應在可信內網／宿主機路徑使用。容器內不要改用宿主機的 `pwrstat`。

## NUT

```env
UPS_SOURCE=nut
NUT_HOST=<容器可達的主機 IP>
NUT_UPS_NAME=cyberpower
```

SmartHub 執行 `upsc <name>@<host>`，讀取 `ups.status`、輸入／輸出電壓、電池、續航與負載。容器內的 `localhost` 是容器自己。

## 本機來源

- `pwrstat`：CyberPower CLI，適合直接在安裝 PowerPanel 的主機執行。
- `pmset`：macOS 原生，通常只有電池、供電與續航，沒有完整電壓／負載。

這兩條路徑不適用一般 Docker 容器。

## 可靠性

- 連續 3 次全來源失敗才確認 offline，短暫錯誤不立即清空狀態。
- 保留最後成功資料並標示 stale。
- 來源切換、離線／恢復與斷電事件去重。
- 電壓歷史、斷電與電力品質事件存入 SQLite；重啟時可接續未結束的斷電事件。
- 總覽或 UPS 頁面可見時，每 3 秒真正讀取一次來源；無人觀看時預設每 10 秒讀取。
- 輸入電壓低於 105V（220V 系統自動換算為 210V）會記錄一次壓降，恢復門檻帶有遲滯，避免在臨界值反覆通知。
- PPB 原廠事件每 60 秒背景同步；觀看 UPS 頁時為 10 秒。事件以原廠 ID 或穩定雜湊去重，第一次同步不推播舊事件。
- 單次輪詢只能捕捉落在取樣點上的壓降；短於 3 秒的閃爍仍需 UPS 韌體實際產生 Power Sag／Utility Voltage Abnormal 事件，SmartHub 才能從 PPB 補捉。

## 路由

- `/api/ups/status`
- `/api/ups/history`
- `/api/ups/events`
- `/api/ups/ppb-events`
- UPS CSV 匯出路徑

故障時先看：

```bash
docker compose --env-file config/.env logs | grep 'UPS\\|Diag'
```
