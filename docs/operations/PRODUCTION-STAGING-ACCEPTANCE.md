# SmartHub Production-like Staging Acceptance Matrix

這是一份實際部署前的驗證清單，不是 mock／CI 的替代品。所有項目在本次程式交付中先標記 `NOT RUN`；只有取得可重現的命令、時間、exact image revision、log 與結果後，才可改為 `PASS` 或 `FAIL`。

## Entry conditions

- 使用 Draft PR 指定的 exact branch HEAD 與成對 immutable image tag/digest。
- `config/.env` 以 0600 保存，secret 不進 log、報告、browser response 或 backup artifact。
- staging 的 UniFi Controller、Device SSH、NAS、UPS／PPB、WiiM、AdGuard、Linux 與通知帳號均為明確授權的測試資產。
- 建立獨立 SQLite／WAL／SHM backup、`config/.env` 加密副本、restore destination 與回滾窗口。
- 先驗證 loopback／reverse proxy／TLS、`/health/ready`、Docker image identity、resource limit 與 log retention。

## Read-only and lifecycle matrix

| Area | Procedure | Acceptance evidence | Status |
|---|---|---|---|
| Controller | 登入、讀取 clients/devices/health/WiFi、確認 telemetry 原始欄位 | source field、採樣時間、無估算溫度、無 secret 泄漏 | `NOT RUN` |
| Device SSH | 只對 allowlist device 連線，驗 SHA256 host key、thermal command timeout、unsupported/stale 狀態 | mismatch fail-closed、close/reconfigure 不出現 late command | `NOT RUN` |
| Controller restart | 在維護窗重啟 Controller，觀察 session、cache、stale、recovery | bounded relogin、無錯誤重複寫入或通知 storm | `NOT RUN` |
| NAS API | 登入、JWT refresh、overview/disks/volumes/SMART、sleep log | timeout／401 不污染 token；資料 freshness 與 source 明確 | `NOT RUN` |
| NAS Monitor | profile 啟用、read-only inventory/log/alerts、SSE slow client | mutation/log allowlist、protected container、disconnect cleanup | `NOT RUN` |
| WiiM | status/history/artwork，驗 device literal／redirect／TLS policy | artwork SSRF boundary、stale cache、shutdown cleanup | `NOT RUN` |
| AdGuard | overview/querylog/read-only policy list | remote HTTP 只有 explicit opt-in；TLS／CA 正確 | `NOT RUN` |
| Linux SSH | stats/history、host-key、timeout、offline/recovery | 無未 pin 連線；不因上游 outage 令 readiness 失敗 | `NOT RUN` |
| UPS healthy | PPB `UPS_SOURCE=ppb`、status/history/events | `configuredSource=ppb`、`actualSource=ppb`、真實 voltage/battery fields | `NOT RUN` |
| UPS strict failure | 暫停 PPB 或讓 PPB 不可達，保持 `UPS_ALLOW_FALLBACK=false` | 不嘗試其他來源；`source=unreachable`、`actualSource=null`、`lastKnown` stale | `NOT RUN` |
| UPS explicit fallback | 明確設定 `UPS_ALLOW_FALLBACK=true`，讓 primary fail、secondary healthy | `fallbackUsed=true`、reason/source 可追溯、無 silent switch | `NOT RUN` |
| UPS PPB events | 背景同步、重啟、重複事件與短暫 outage | GET 只讀 snapshot；SQLite dedup、首次 baseline 不通知舊事件 | `NOT RUN` |
| Notifications | Telegram／Webhook／其他 configured channel success and failure | secret masking、bounded retry、partial delivery/audit truthful | `NOT RUN` |

## Persistence, backup and deployment matrix

| Area | Procedure | Acceptance evidence | Status |
|---|---|---|---|
| SQLite migration | fresh DB、current DB、restart、quick check | migration idempotent、WAL healthy、no JSON whole-file history restore | `NOT RUN` |
| Online backup | create v2 backup while service is active, inspect manifest/checksum | no secrets、bounded memory、valid MIME/version/hash | `NOT RUN` |
| Offline backup | stop service, copy DB/WAL/SHM and encrypted env to different storage | files open/quick-check; restore source is independent | `NOT RUN` |
| Restore | restore to isolated DATA_DIR, test checksum/truncation/mismatch | staging/atomic replacement/rollback preserve original on failure | `NOT RUN` |
| Host reboot | reboot staging host or restart Docker engine | container restart, readiness, sampler and DB recovery without duplicate jobs | `NOT RUN` |
| Resource soak | monitor RSS/heap/SQLite growth/log volume/SSE/active handles | minimum 24h, preferred 72h trend within documented budgets | `NOT RUN` |
| Reverse proxy | HTTPS login, Secure cookie, trusted forwarded headers, loopback backend | untrusted forwarded header cannot bypass HTTPS policy | `NOT RUN` |
| Image supply chain | inspect OCI revision/dirty labels, SBOM, fixed+unfixed Trivy JSON | exact source/image pair, no hidden unfixed HIGH/CRITICAL findings | `NOT RUN` |
| Docker Monitor risk | review socket path/GID and protected target behavior | explicit owner acceptance of host-root-equivalent socket risk | `NOT RUN` |

## Controlled write and recovery matrix

Only execute these with a written rollback plan and an operator observing the actual device:

- UniFi block/unblock or PoE power cycle.
- NAS Docker stop/restart/log actions within allowlists.
- AdGuard protection/service-policy changes.
- WiiM playback/volume/input commands.
- UPS outage simulation only with an authorized test load and safe power window.
- Configuration restore and rollback.

Each action must record target identity, operator, start/end time, request result, external observed result, and recovery result. An HTTP 200 alone is not acceptance evidence for a remote mutation.

## Completion rule

The staging owner may promote a row only when the evidence is attached to the exact release revision. The production finalization task remains `CODE_READY_REAL_ENV_PENDING` while any live row or the 24/72-hour soak remains `NOT RUN`; it must not be reported as `PRODUCTION_ACCEPTANCE_COMPLETE`.
