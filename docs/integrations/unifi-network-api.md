# UniFi 整合摘要

本文件只描述 SmartHub 目前使用的 UniFi 契約，不是完整上游 API 規格。修改上游路徑時應同時核對官方文件、source 與測試。

## 四種連線

| 用途 | 設定 | 實作 |
|---|---|---|
| 本地控制器 | `UNIFI_CONTROLLER_URL`, `UNIFI_USERNAME`, `UNIFI_PASSWORD` | 登入 `/api/auth/login`，快取 cookie／CSRF；讀取 clients、WiFi、threats，執行封鎖、PoE、speedtest |
| Device SSH 溫度（選填） | `UNIFI_DEVICE_SSH_*` | 只對 Controller 已知、MAC allowlist 內且 online 的 Literal IP 執行固定唯讀 thermal command |
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

## 裝置遙測與溫度真值

Controller 提供 online、model、firmware、IP、uptime、uplink／link、流量、radio／channel、VAP／SSID、client、packet／error／drop 與 CPU。只有 `has_temperature=true` 且值在合理範圍內的 Controller 溫度才採用；不由 CPU 推算，也不把 offline 殘留值寫入歷史。

Device SSH 是選配 fallback：`UNIFI_DEVICE_SSH_TARGET_IDS` 最多 32 個 canonical MAC；目標必須同時存在於 Controller、online 且有安全 Literal IPv4／IPv6。命令固定、12 秒 timeout、128 KiB output cap、per-device cache／singleflight、全域最多兩個工作。`UNIFI_DEVICE_SSH_HOST_KEYS` 可用 `mac=SHA256:...` 逐台釘選；設定輪替與 shutdown 都會取消舊候選連線。密碼、MAC allowlist 與 fingerprint 在 Settings GET、diagnostics、log、backup 都只顯示是否設定或數量。

U7 Pro、USW Flex 2.5G 或其他設備若 Controller／SSH 都沒有真實溫度，狀態是 `unsupported`，UI 顯示「不支援」而不是 `0°C`。API 只讀專用 snapshot；獨立 sampler 預設 UCG 頁可見時 60 秒、閒置 300 秒更新並以 SQLite transaction 保存，stale 樣本不入庫也不觸發通知。

## 暫時威脅來源封鎖

必要設定：

```env
UNIFI_NETWORK_API_KEY=...
UNIFI_NETWORK_SITE_ID=<uuid>
UNIFI_THREAT_BLOCK_LIST_ID=<uuid>
UNIFI_THREAT_BLOCK_LIST_NAME=SmartHub Threat Blocks
TRUSTED_LAN_MODE=true
UNIFI_NETWORK_TLS_VERIFY=false
UNIFI_NETWORK_CA_FILE=
UNIFI_NETWORK_TLS_INSECURE=true
UNIFI_NETWORK_ALLOW_INSECURE_HTTP=true
```

若未明確設定 `UNIFI_NETWORK_API_URL`，會由 `UNIFI_CONTROLLER_URL` 推導 `/proxy/network/integration`。

安全契約：

- TLS 預設驗證；私有 CA 使用 `UNIFI_NETWORK_CA_FILE`。只有明確 `UNIFI_NETWORK_TLS_INSECURE=true` 才可停用驗證，只有明確 `UNIFI_NETWORK_ALLOW_INSECURE_HTTP=true` 才可使用非 loopback HTTP。
- Trusted LAN mode 只對分類為私有 endpoint 的 Network Integration API 產生 `trusted-lan-insecure` policy；`api.ui.com`／Site Manager 與其他 Internet integration 不會沿用這份 policy。
- 啟動時由共用 TLS policy 讀取並解析有界的 CA bytes；GET／PUT transport 只使用 resolved policy，不會再次讀取 raw CA path。insecure HTTPS 或明確 HTTP 模式不會因 stale CA path 被重新讀取而失敗。
- 設定頁回傳 `clearableFields`；清空 `UNIFI_NETWORK_CA_FILE` 會明確清除 CA path，清空 `UNIFI_NETWORK_API_URL` 會恢復由 `UNIFI_CONTROLLER_URL` 推導的 endpoint。secret 欄位留空仍代表不變更。
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
