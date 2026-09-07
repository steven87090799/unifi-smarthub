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

`auto` 會依序回退並在狀態中回報 `configuredSource`／`actualSource`。明確指定來源時預設 fail-closed；若要在該來源失敗後回退，必須另外設定：

```env
UPS_SOURCE=ppb
UPS_ALLOW_FALLBACK=true
```

未啟用回退時，失敗狀態會回報 `source=unreachable`、`actualSource=null`，最後一次成功資料只會放在 `lastKnown`。

UPS 狀態另外提供 `fetchHealth`：`healthy` 代表目前取樣成功，`degraded` 代表短暫失敗但仍保留最後成功數值，`offline` 代表連續 3 次全來源失敗，`unknown` 代表尚未取得任何成功資料。`degraded`／`offline` 的數值都是 stale；前端會以黃色／紅色顯示，且不把 `lastKnownSource` 當成目前可達來源。

UPS 連線設定熱更新時會遞增 `configGeneration` 並短暫標示 `reconfiguring`。切換期間，舊設定的延遲結果會被丟棄；只有新 generation 成功取樣後才恢復綠色 healthy 與 `actualSource`。

## Docker 建議：PPB REST

```env
UPS_SOURCE=ppb
PPB_HOST=host.docker.internal
PPB_PORT=3052
PPB_USER=...
PPB_PASSWORD=...
TRUSTED_LAN_MODE=true
PPB_TLS_VERIFY=true
PPB_TLS_INSECURE=false
# 私有／自簽 CA：PPB_CA_FILE=/app/config/ppb-ca.pem
```

流程：

1. 對 `http://<host>:3052/local/` 探索實際 HTTPS port。
2. 呼叫 `/local/rest/v1/login/verify` 取得 token。
3. 讀取 `/local/rest/v1/ups/status` 與事件 API。
4. 401／403 時重新登入一次；服務重啟後重新探索 port。

`TRUSTED_LAN_MODE` 是 compatibility master switch；安全 baseline `PPB_TLS_VERIFY=true`、`PPB_TLS_INSECURE=false` 在私有 endpoint classification 下會自動產生 scoped `rejectUnauthorized=false`。只有明確的 legacy/manual insecure override 才會顯示 `explicitly-insecure`，不會冒充 Trusted LAN。discovery 後的 login、status 與 event sync 共用同一份 effective policy。公網 endpoint 仍維持 verified TLS；關閉 Trusted LAN 後不會自動接受 self-signed TLS、HTTP 或 unpinned SSH。私有 CA 與 SSH fingerprint 永遠優先。容器內不要改用宿主機的 `pwrstat`。

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
- UPS 失敗日誌以狀態轉移、fallback 邊界、恢復與 cooldown 摘要為界，重複輪詢錯誤不逐筆刷屏；全來源失敗會列出實際嘗試來源。
- 電壓歷史、斷電與電力品質事件存入 SQLite；重啟時可接續未結束的斷電事件。
- 總覽或 UPS 頁面可見時，每 3 秒真正讀取一次來源；無人觀看時預設每 10 秒讀取。
- `/api/ups/status` 與 `/api/ups/ppb-events` 是只讀快照；外部讀取、SQLite 寫入、狀態轉移與通知只由背景 sampler 執行。
- 輸入電壓低於 105V（220V 系統自動換算為 210V）會記錄一次壓降，恢復門檻帶有遲滯，避免在臨界值反覆通知。
- PPB 原廠事件每 60 秒背景同步；觀看 UPS 頁時為 10 秒。事件以原廠 ID 或穩定雜湊去重，第一次同步不推播舊事件。
- `UPS_SOURCE=ppb` 且 `UPS_ALLOW_FALLBACK=false` 時只嘗試 PPB；短暫失敗保留 last-good，連續失敗門檻前不確認 offline，PPB event sync 的重複錯誤使用 cooldown/backoff。
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
