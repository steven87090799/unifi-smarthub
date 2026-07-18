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
- `/api/threats`, `/api/device/restrict`, `/api/poe/power-cycle`
- `/api/speedtest`, `/api/speedtest/status`
- `/api/cloud/sites`, `/devices`, `/isp-metrics`, `/hosts`, `/sdwan`

Site Manager client 有頁數／項目上限、重複 token 防護、429 `Retry-After` 與有界退避。未設定 `UNIFI_API_KEY` 時回 `not_configured`。

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
