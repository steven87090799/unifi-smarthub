# WiiM 整合摘要

SmartHub 透過 LinkPlay `httpapi.asp` 讀取 WiiM 狀態並執行受限控制。此文件只列目前面板允許的行為。

## 連線與取樣

```env
WIIM_IP=
TRUSTED_LAN_MODE=true
WIIM_TLS_INSECURE=true
WIIM_ALLOW_INSECURE_HTTP=true
```

- `WIIM_IP` 必須是實際 IPv4/IPv6 literal；留空即停用整合，不會啟動取樣、診斷、指令或頁面資料讀取。
- 先嘗試 `https://<ip>/httpapi.asp?command=...`；只有明確設定 `WIIM_ALLOW_INSECURE_HTTP=true` 才允許 HTTP。
- `TRUSTED_LAN_MODE=true` 只會對分類為私有／allowlist 的 WiiM endpoint 接受自簽憑證；公網 endpoint 不會受到模式影響。`WIIM_TLS_INSECURE=true` 與 `WIIM_ALLOW_INSECURE_HTTP=true` 仍只放行精確設定的 private literal，public artwork CDN 每一跳仍必須使用已驗證的 HTTPS。
- 封面代理固定每一跳 DNS 解析地址，最多跟隨 3 次 redirect、只接受影像 MIME，單項最多 2 MiB；同時最多 4 個 upstream、最多排隊 16 個工作、單次 deadline 7 秒，並使用有項數／總大小／TTL 上限的 LRU 快取與同 key 去重。
- 常用唯讀指令有 2 秒快取；失聯時最多保留 5 分鐘的 `stale_cache` 顯示資料。stale 不代表在線、不寫入溫度歷史、不觸發成功／恢復通知，也不能回報異動命令成功。
- `getStatusEx` 的溫度寫入 SQLite；WiiM 頁活動時使用一般裝置取樣設定，預設 5 秒，閒置時回到設定的低頻。
- 只有至少一個有限數值溫度欄位才寫入 SQLite；malformed、缺欄位、`NaN`、`Infinity` 與 `null/null` 回應會跳過。正式服務不把模擬數據寫入歷史。

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
