# WiiM 整合摘要

SmartHub 透過 LinkPlay `httpapi.asp` 讀取 WiiM 狀態並執行受限控制。此文件只列目前面板允許的行為。

## 連線與取樣

```env
WIIM_IP=192.168.0.170
WIIM_TLS_INSECURE=false
# WIIM_CA_FILE=/app/config/wiim-ca.pem
# WIIM_ALLOW_INSECURE_HTTP=false
```

- 預設只用 `https://<ip>/httpapi.asp?command=...`，單次 timeout 3 秒；HTTP 只有 `WIIM_ALLOW_INSECURE_HTTP=true` 才會嘗試。
- HTTPS 預設驗證憑證；自簽憑證請以 `WIIM_CA_FILE` 掛載私有 CA，`WIIM_TLS_INSECURE=true` 是僅供受控測試的例外。
- 常用唯讀指令有 2 秒快取；失聯時可回最後一筆快取，但正式狀態標示來源／不可達。
- `getStatusEx` 的溫度寫入 SQLite；WiiM 頁活動時使用一般裝置取樣設定，預設 5 秒，閒置時回到設定的低頻。
- 正式服務不把模擬數據寫入歷史。

## SmartHub 路由

| 路徑 | 用途 |
|---|---|
| `GET /api/wiim/status` | 播放、metadata、系統狀態 |
| `GET /api/wiim/cmd?command=...` | 只允許唯讀命令 |
| `POST /api/wiim/cmd` | 受保護異動命令 |
| `GET /api/wiim/art` | 有 SSRF 邊界的封面代理 |
| `GET/DELETE /api/wiim/history` | SQLite 歷史 |
| `GET /api/wiim/csv` | 匯出溫度 CSV |

## 命令政策

固定唯讀命令包含狀態、preset、EQ、藍牙掃描結果、shutdown 與 Squeezelite 狀態。固定異動命令包含播放控制、EQ 開關、燈號、按鍵、Cast、reboot 與解除群組。

參數化命令分別驗證：

- 音量 `0–100`
- seek、shutdown、藍牙掃描秒數與 SPDIF delay
- 輸入源、preset、EQ band、gain、亮度與群組 IP
- canonical URL encoding 與 canonical JSON

規則：

- 讀取只接受 GET；異動只接受 POST。
- 未知、prefix-only、控制字元、超長或非 canonical 編碼一律拒絕。
- `reboot`、群組變更等高風險操作需要 request body 中的精確 command confirmation。
- 面板角色、Origin 與 CSRF 仍由共用安全 middleware 執行。

權威實作：

- `server/policies/wiim-command-policy.js`
- `server/routes/wiim-command-routes.js`
- `test/wiim-command-policy.test.js`

不要恢復任意命令代理，也不要依賴上游「所有異動都用 GET」的原始介面設計。

封面代理只接受 WiiM 已知主機，或明確列於 `WIIM_ART_ALLOWED_HOSTS` 的 external host。每次 DNS lookup 都拒絕 loopback、private、link-local、CGNAT、ULA 與 multicast 位址，使用已驗證 IP 連線以避免 rebinding；不跟隨 redirect，只接受 JPEG/PNG/WebP/GIF 並限制串流大小與 LRU cache。
