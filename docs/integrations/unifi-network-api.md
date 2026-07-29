# UniFi 整合摘要

本文件只描述 SmartHub 目前使用的 UniFi 契約，不是完整上游 API 規格。修改上游路徑時應同時核對官方文件、source 與測試。

## 三種連線

| 用途 | 設定 | 實作 |
|---|---|---|
| 本地控制器 | `UNIFI_CONTROLLER_URL`, `UNIFI_USERNAME`, `UNIFI_PASSWORD` | 登入 `/api/auth/login`，快取 cookie／CSRF；讀取 clients、WiFi、threats，執行封鎖、PoE、speedtest |
| Site Manager | `UNIFI_API_KEY` | `https://api.ui.com/v1`；站點、設備、ISP、hosts、SD-WAN |
| Network Integration API | `UNIFI_NETWORK_*`, `UNIFI_THREAT_BLOCK_LIST_*` | 專用 traffic matching list，用於暫時封鎖外部 IPv4 |

前端只呼叫 SmartHub；所有 UniFi credential 僅存在後端。

## 本地與雲端路由

- `/api/clients`, `/api/network/switches`, `/api/wifi-networks`
- `/api/network/devices/telemetry`, `/api/network/devices/telemetry/history`
- `/api/threats`, `/api/device/restrict`, `/api/poe/power-cycle`
- `/api/speedtest`, `/api/speedtest/status`
- `/api/cloud/sites`, `/devices`, `/isp-metrics`, `/hosts`, `/sdwan`

Site Manager client 有頁數／項目上限、重複 token 防護、429 `Retry-After` 與有界退避。未設定 `UNIFI_API_KEY` 時回 `not_configured`。

## 設備 CPU 與溫度真實性

設備遙測讀取本地控制器 `/proxy/network/api/s/default/stat/device`：

- CPU 只接受 `system-stats.cpu` 的有限數值，畫面同步顯示來源欄位。
- 溫度先要求設備明確回報 `has_temperature=true`，再接受已知的溫度欄位。
- `has_temperature=false` 時，即使 payload 中出現看似溫度的其他數字也不採用。
- 未回報溫度時，僅在管理者已選取 MAC、設備在線且具有已驗證的 IPv4/IPv6 管理 IP、並設定獨立 Device SSH Authentication 時，才以固定唯讀指令讀取 `/sys/class/thermal/thermal_zone*/temp`；host 名稱、unspecified、multicast、broadcast 與 loopback 都拒絕。
- Controller 真實溫度優先於 Device SSH；SSH 讀到的是內部感測器 zone，最高 zone 不必然是 CPU／SoC，也不等於外殼表面溫度。
- Device SSH 使用 `UNIFI_DEVICE_SSH_*`，與 UCG Console SSH 和 UniFi 網頁登入帳密完全分離。`UNIFI_DEVICE_SSH_TARGET_IDS` 是最多 32 個以逗號分隔的 Controller MAC allowlist；留空即停用。
- 未回報溫度的設備會清楚顯示未設定、未選取、找不到 allowlist MAC、Controller 離線、認證失敗、不可達或沒有 thermal zone，不使用估算值。離線設備不執行 SSH，最後成功值只以 stale 顯示。
- 歷史寫入 SQLite `history` 表的 `unifiDevices` series；過熱通知只根據通過上述驗證的溫度。

UCG 自身透過 SSH `ubnt-systool cputemp` 取得的核心溫度仍保留在既有 UCG 卡片，與控制器設備遙測分開標示來源。Device SSH pool 保存 host、port、username 與設定 generation；其中任何一項改變都先關閉舊 pool，再以新值建立連線。設定更新會作廢排隊工作與 inflight 結果，舊結果不能寫入 cache/history 或觸發通知。SSH 過期值只作資料品質提示，不會寫成新 history 點或觸發高溫通知；新的 Device SSH 取樣預設前景 60 秒、背景 300 秒、同時最多 2 台。`GET /api/network/devices/telemetry` 只讀取最後 snapshot：首次以 singleflight 初始化，後續讀取不會重新查 Controller 或建立 SSH；snapshot 超過目前 interval 三倍（最低 15 分鐘）會標示 stale。

## 暫時威脅來源封鎖

必要設定：

```env
UNIFI_NETWORK_API_KEY=...
UNIFI_NETWORK_SITE_ID=<uuid>
UNIFI_THREAT_BLOCK_LIST_ID=<uuid>
UNIFI_THREAT_BLOCK_LIST_NAME=SmartHub Threat Blocks
UNIFI_NETWORK_TLS_VERIFY=true
```

若未明確設定 `UNIFI_NETWORK_API_URL`，會由 `UNIFI_CONTROLLER_URL` 推導 `/proxy/network/integration`。

安全契約：

- 非 loopback 必須 HTTPS；TLS 預設驗證。
- 清單必須是名稱、ID 完全相符的專用 `IPV4_ADDRESSES` list。
- 不得與人工項目或其他自動化共用。
- 只接受單一公網 IPv4；管理位址、私有、loopback、link-local、reserved 與 IPv6 都拒絕。
- 每筆有 15 分鐘至 30 天到期時間。
- SmartHub 使用完整 GET／PUT 驗證收斂；空集合保留 `192.0.2.1` sentinel。
- desired state、audit、retry 與 expiry 存於 SQLite；UniFi 暫時離線時會有界重試。

主要實作：

- `server/integrations/unifi-traffic-list-client.js`
- `server/policies/threat-ip-policy.js`
- `server/services/threat-ip-blocking.js`

## 變更檢查

- 不要把 frontend button 隱藏當成授權。
- 新異動路由必須套用 admin、Origin、CSRF、輸入驗證與 audit。
- 使用 mock／fake controller 測試，不要在一般測試寫入真實 UniFi。
