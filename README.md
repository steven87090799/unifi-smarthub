# SmartHub 家用基礎設施戰情室

SmartHub 是自架的 Node.js／Express 管理面板，整合 UniFi、UCG、UGREEN NAS、Docker、WiiM、CyberPower UPS、AdGuard Home、Linux 主機與多種通知管道。正式環境使用 Docker；前端不直接接觸上游帳密或 API key。

- 正式服務：`server.js`，port `3000`
- 開發假資料：`server-mock.js`，port `3005`
- 歷史資料：SQLite `data/smarthub.db`
- 目前版本：`3.0.0`
- 文件索引：[docs/README.md](docs/README.md)
- 完整操作與文件規格：[SMARTHUB_COMPLETE_OPERATION_MANUAL_ZH_TW.html](SMARTHUB_COMPLETE_OPERATION_MANUAL_ZH_TW.html)
- 正式發布：[docs/operations/PRODUCTION-RELEASE-CHECKLIST.md](docs/operations/PRODUCTION-RELEASE-CHECKLIST.md)
- 最終驗證：[docs/reports/PRODUCTION_READINESS_REPORT.md](docs/reports/PRODUCTION_READINESS_REPORT.md)
- 長期硬化報告：[docs/reports/PRODUCTION_LONG_RUN_HARDENING_REPORT.md](docs/reports/PRODUCTION_LONG_RUN_HARDENING_REPORT.md)
- Post-merge audit：[docs/reports/POST_MERGE_AUDIT_HARDENING.md](docs/reports/POST_MERGE_AUDIT_HARDENING.md)
- Production Acceptance：[docs/operations/PRODUCTION_ACCEPTANCE.md](docs/operations/PRODUCTION_ACCEPTANCE.md)

## 主要能力

- 14 個頁面：總覽、UCG、客戶端、資安、WiFi、雲端站點、NAS、WiiM、UPS、AdGuard、Linux、工具、通知、設定。
- 設定驅動的活動頁更新與後端自適應取樣；一般裝置預設 5 秒、UPS 即時狀態預設 3 秒，離開頁面後自動回到低頻。
- UCG 頁提供 UniFi 裝置 Controller 遙測與可選的唯讀 Device SSH 真實溫度；不支援時明確顯示「不支援」，不推算或偽造溫度。
- 管理員／唯讀角色、Session、CSRF、Origin 檢查、登入節流與受保護寫入路由。
- SQLite 歷史、事件、報表、政策、Web Push、備份／還原與重啟復原。
- Discord、Telegram、Webhook、Web Push 與 Telegram 指令中心。
- 可選的 NAS Monitor；Docker 操作與日誌各自使用明確 allowlist。

## 快速開始

需求：Node.js 24.18.x（`.nvmrc`）；正式部署另需 Docker Compose。

```bash
git clone <repository-url>
cd unifi-smarthub

# SmartHub container 預設以 UID/GID 1000:1000 執行；config 與 .env 必須由該 UID 實際可讀寫。
sudo install -d -o 1000 -g 1000 -m 700 config
if [ ! -e config/.env ]; then
  sudo install -o 1000 -g 1000 -m 600 .env.example config/.env
else
  # 已存在的 config/.env 不要覆寫，只調整必要 owner/mode。
  sudo chown 1000:1000 config config/.env
  sudo chmod 700 config
  sudo chmod 600 config/.env
fi
# 編輯 config/.env，正式環境至少設定 PANEL_PASSWORD

npm ci
# 固定順序：先建立映像，再以同一映像做離線 writer/preflight gate，最後只啟動已建立的映像。
docker compose --env-file config/.env build unifi-smarthub
docker compose --env-file config/.env --profile nas-monitor build
# 僅第一次使用全新的 smarthub-data volume 時執行一次；既有資料庫不要覆蓋。
docker compose --env-file config/.env run --rm --no-deps \
  unifi-smarthub node -e "const { createHistoryDb } = require('./db'); const db = createHistoryDb(process.env.DATA_DIR); db.close();"
docker compose --env-file config/.env run --rm --no-deps \
  unifi-smarthub node scripts/production-preflight.js --offline
docker compose --env-file config/.env up -d --no-build
docker compose --env-file config/.env ps
```

本機隔離演練可開啟 `http://127.0.0.1:3000`。正式環境不可把 `http://<NAS IP>:3000` 當作對外入口；請以前置 Caddy／Nginx 終止 HTTPS，再反向代理至 SmartHub 的內部 port。

### 可信任內網最簡部署

1. `cp .env.example config/.env`
2. 保留 `TRUSTED_LAN_MODE=true`，只填設備 IP、帳號與密碼。
3. `docker compose --env-file config/.env build unifi-smarthub`
4. `docker compose --env-file config/.env run --rm --no-deps unifi-smarthub node scripts/production-preflight.js --offline`
5. `docker compose --env-file config/.env up -d --no-build`
6. `docker compose --env-file config/.env ps`
7. 檢查 `/health`、`/health/ready` 與設定頁的整合狀態。

`TRUSTED_LAN_MODE` 是 compatibility master switch。安全 baseline（TLS verify=true、insecure=false、HTTP=false、SSH unpinned=false）只會在私有 IP、loopback、`host.docker.internal` 與 `TRUSTED_LAN_HOSTS` 完全相符的 hostname 上產生 scoped 自簽 TLS、私有 HTTP 與 SSH Host Key 相容傳輸。關閉模式後不會自動接受 self-signed TLS、HTTP 或 unpinned SSH；若另設 legacy/manual insecure override，狀態會顯示 `explicitly-insecure`／`explicit-insecure-http`，不會冒充 Trusted LAN。configured CA／SSH fingerprint 永遠優先。它絕不影響 Site Manager、Telegram、Discord、Webhook、外部圖片/CDN 或其他 Internet integration 的 TLS 驗證；公開部署應設為 `false` 並改用正式 CA／fingerprint。

Compose 的 host-side port 預設只發布到 `127.0.0.1`（`SMARTHUB_HOST_BIND_ADDRESS`）；容器內服務仍綁定 `0.0.0.0` 以接受同一 network 的 reverse proxy。若要改成 LAN 發布，必須明確設定 host bind address 並同步套用防火牆／HTTPS 邊界。

若 NAS 使用者不是 UID/GID 1000，請在部署主機以 `chown 1000:1000` 或等效 ACL 讓 container process 讀取 `config/.env`，並能在 `config/` 與 `/app/data` 建立、fsync、atomic rename、刪除暫存檔。不要以 `chmod 777`／`666` 掩蓋權限問題；`production-preflight` 必須在實際 container UID 下通過。

正式入口分兩種架構：

- Host-native Caddy/Nginx：proxy 與 SmartHub 在同一台主機，proxy 導向 `127.0.0.1:3000`，並在 `PANEL_TRUSTED_PROXIES` 填實際 loopback／proxy CIDR；傳遞正確的 `Host` 與 `X-Forwarded-Proto=https`。
- Dockerized Caddy/Nginx：proxy container 與 `unifi-smarthub` 接在同一個 Docker network，導向 `unifi-smarthub:3000`，不可在 proxy container 內使用 `127.0.0.1:3000`。`PANEL_TRUSTED_PROXIES` 必須填 proxy container 的實際 IP／受控 CIDR，不能填 `true`、`*` 或 hop count。

若 production 啟用 HTTPS enforcement 卻未設定 trusted proxy，SmartHub 會記錄診斷 warning，但不會自動信任所有 forwarded headers；直接 TLS 可繼續使用，TLS termination reverse proxy 則必須補上實際 proxy IP/CIDR。

本機直接執行：

```bash
SMARTHUB_ENV_FILE=config/.env npm start
```

純假資料預覽：

```bash
node server-mock.js
```

## 重要設定

完整欄位與安全預設以 [.env.example](.env.example) 為準。

| 整合 | 主要欄位 |
|---|---|
| Trusted LAN | `TRUSTED_LAN_MODE`, `TRUSTED_LAN_HOSTS` |
| UCG SSH | `UCG_IP`, `SSH_USER`, `SSH_PASSWORD` |
| UniFi 本地 | `UNIFI_CONTROLLER_URL`, `UNIFI_USERNAME`, `UNIFI_PASSWORD` |
| UniFi 裝置溫度（選填） | `UNIFI_DEVICE_SSH_PORT`, `UNIFI_DEVICE_SSH_USER`, `UNIFI_DEVICE_SSH_PASSWORD`, `UNIFI_DEVICE_SSH_TARGET_IDS`, `UNIFI_DEVICE_SSH_HOST_KEYS` |
| UniFi 雲端 | `UNIFI_API_KEY` |
| UGREEN NAS | `NAS_HOST`, `NAS_USER`, `NAS_PASSWORD` |
| NAS Monitor | `NAS_MONITOR_URL`, `NAS_MONITOR_API_KEY`, `NAS_MONITOR_MODE` |
| WiiM | `WIIM_IP` |
| UPS | `UPS_SOURCE`、`UPS_ALLOW_FALLBACK`、`PPB_*`、`NUT_*`；PPB TLS 見下節 |
| AdGuard | `ADGUARD_URL`, `ADGUARD_USER`, `ADGUARD_PASSWORD` |
| Linux SSH | `LINUX_HOST`, `LINUX_SSH_USER`, `LINUX_SSH_PASSWORD` |
| 面板登入 | `PANEL_PASSWORD`；唯讀帳號另設 `PANEL_READONLY_*` |

沒有設定的整合會顯示未設定或空狀態，不應阻止主服務就緒。

`WIIM_IP` 是選配 literal IP；留空即停用 WiiM，不會產生模擬溫度、播放狀態或診斷資料。

設定頁的「可信任內網相容模式」是管理員可修改的單一開關；GET 只回傳非機密欄位與 `secretsSet`，不回傳密碼、API key、cookie、token、CA 內容或完整 SSH fingerprint。設定更新使用既有 atomic `.env` writer；需要重建的 NAS Monitor 連線會明確標示待 recreate。

## 安全與部署邊界

- 只部署在可信任內網；遠端存取使用 VPN 或受信任反向代理。
- `config/.env` 是唯一部署設定來源，權限應為 `0600`；不要在根目錄保留第二份 `.env`。
- SmartHub container 預設 UID/GID 為 `1000:1000`；啟動前必須以 [production preflight](scripts/production-preflight.js) 驗證 config/data 寫入與 atomic rename。
- `production-preflight` 不會替空資料 volume 偷建資料庫；第一次使用新的 `smarthub-data` volume 時，先以同一個 image 執行一次 `createHistoryDb` 初始化 schema，既有資料庫不可覆蓋。
- 正式部署順序固定為 `build` → `production-preflight.js --offline` → `up -d --no-build`；preflight 不得在 build 前執行，也不得以 `up --build` 繞過同一映像驗證。
- 所有 Compose 指令都使用同一個 `--env-file config/.env`。
- 正式映像使用不可變的 commit tag 或 registry digest，不使用 `latest`；主服務預設 256 MiB，只有在 soak／backup 證據支持時才調整。
- `nas-monitor` 預設不啟用。可寫 Docker socket 等同宿主機 root 權限；詳見 [Docker 容器管理指南](docs/operations/NAS-DOCKER-MONITOR-SETUP.md)。
- 前端依賴與 WiFi QR 均由 SmartHub 同源提供，不把 SSID、密碼或遙測送往第三方服務。
- Dashboard JavaScript 全部由同源外部檔案載入；CSP 的 `script-src` 只有 `'self'`，不允許 inline script、inline handler 或 `unsafe-eval`。
- Device SSH 只接受 Controller 已知設備、最多 32 個明確 MAC、Literal IP 與固定唯讀 thermal command；最多兩條並行連線，可用每台設備的 SHA256 Host Key pinning。密碼、MAC 清單與 fingerprint 不由 GET、診斷、log 或安全備份回傳。
- Trusted LAN mode 不會建立共用的 insecure Axios client，也不使用 `NODE_TLS_REJECT_UNAUTHORIZED=0`；每個 LAN integration 都有自己的 scoped transport。AdGuard connectivity 與 protection 狀態分開追蹤，連續 3 次失敗才通知離線、連續 2 次成功才通知恢復；Site Manager 使用相同 debounce，但持續使用正常 Internet TLS。
- 正式映像不可從 dirty checkout、`latest` 或臨時 `--build` 直接發布。
- Internet/public Axios integrations 的 `SMARTHUB_INTERNET_PROXY_MODE` 預設為 `disabled`；只有明確設為 `environment` 才使用 `HTTP_PROXY`／`HTTPS_PROXY`／`ALL_PROXY`。LAN integrations 永遠不使用 ambient proxy。

## Docker UPS

已驗證路徑是 PowerPanel Business REST：

```env
UPS_SOURCE=ppb
UPS_ALLOW_FALLBACK=false
PPB_HOST=host.docker.internal
PPB_PORT=3052
PPB_USER=...
PPB_PASSWORD=...
PPB_TLS_VERIFY=true
PPB_TLS_INSECURE=false
# 私有／自簽 CA 建議掛載後使用：
# PPB_CA_FILE=/app/config/ppb-ca.pem
```

Trusted LAN mode 對可信任 PPB endpoint 會以同一份 effective policy 套用 discovery 後的 login、status 與 event sync；因此 PPB 自簽憑證不會只在 status 路徑被放寬。`UPS_SOURCE=ppb` 且 `UPS_ALLOW_FALLBACK=false` 時不會嘗試 NUT、pwrstat 或 pmset；UPS 狀態仍保留 last-good，單次失敗不會立即抹除資料。關閉 Trusted LAN 後不會自動接受自簽憑證；請使用正式 CA，或明確且可辨識的 legacy/manual override。

容器內沒有宿主機的 `pwrstat` 或 `pmset`。替代方案是讓容器連到可達的 NUT server；詳見 [UPS 整合摘要](docs/integrations/cyberpower-ups-api.md)。

## 資料與備份

- Docker volume `/app/data` 是正式 runtime 權威來源。
- 歷史、事件、報表與政策使用 SQLite WAL。
- 一般歷史樣本先進入有上限的記憶體佇列，再批次寫入；正常關機與 UPS 狀態轉換會強制 flush。
- 線上安全備份由「設定 → 備份與還原」產生，不包含 secret。
- 完整離線備份應先停止服務，再保存 DB／WAL／SHM；`config/.env` 必須由 NAS 的加密備份機制另行保護，且備份目的地要是不同 storage mount，同一 Docker volume 不等於 disaster recovery。

## 健康檢查

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/health/ready
docker compose --env-file config/.env logs | grep Diag
```

| 路徑 | 用途 |
|---|---|
| `/health` | 程序存活 |
| `/health/ready` | SQLite 與 worker 就緒 |
| `/health/operational` | 受驗證保護的整合與依賴健康摘要 |
| `/api/public/system-health` | 登入頁匿名最小狀態快照 |
| `/api/system/status` | 受驗證保護的完整診斷 |

## 正式發布

Pull Request 會執行 GitHub Actions workflow `SmartHub CI`，其 check 名稱為 `Repository gate`。Gate 使用 Node.js 24.18.x 執行完整測試、`npm audit --audit-level=low`、Compose／雙映像 build、SBOM／HIGH-CRITICAL container scan、blocking 90 秒 short soak，最後以 `npm run test:smoke` 啟動正式 `server.js`，在全臨時資料與 loopback 假整合環境驗證登入、CSRF、權限、SIGTERM 與重啟持久化。

本機也可獨立重跑同一個隔離 smoke：

```bash
npm run test:smoke
```

Repository 管理員應在 `main` branch protection／ruleset 將 `SmartHub CI / Repository gate` 設為 Required Check，並禁止 CI 未通過的 PR merge；若尚未設定，不能把 workflow 存在誤稱為 branch protection 已啟用。

先依 [正式發布檢查清單](docs/operations/PRODUCTION-RELEASE-CHECKLIST.md) 執行必要 gate，再建立不可變成對映像：

```bash
npm run release:build
# 將 release:build 輸出的成對不可變 revision tag 寫入 config/.env：
# SMARTHUB_IMAGE=unifi-smarthub:<12-char-revision>
# NAS_MONITOR_IMAGE=unifi-smarthub-nas-monitor:<12-char-revision>
docker compose --env-file config/.env run --rm --no-deps \
  unifi-smarthub node scripts/production-preflight.js --offline
docker compose --env-file config/.env up -d --no-build --pull never
```

`release:build` 會拒絕 dirty worktree，並驗證 SmartHub／NAS Monitor 的版本、revision、image ID 與映像身分。若使用 registry，仍需成對記錄不可變 digest；部署時保留 release JSON 的 `image_ids` 與 registry digest，不能只記錄可重指向的 tag。

Dockerfile 的 release 供應鏈目前固定為 Node `24.18.0-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd`，直接使用的 Alpine 套件也固定為 `tini=0.19.0-r3`、`nut=2.8.3-r4`、`tzdata=2026c-r0`，以及 build dependencies `python3=3.14.5-r0`、`make=4.4.1-r4`、`g++=15.2.0-r5`。更新任一 pin 時，必須連同 base digest、SBOM、Trivy 報告與成對 image IDs 一起刷新。

## 開發原則

- 先讀 `CONTEXT.md`，再依任務讀 `docs/reference/backend-map.md` 或 `docs/reference/frontend-map.md`。
- 修改前端可見 API／設定時，同步 `server-mock.js` 與契約測試。
- 新歷史資料沿用 `db.js`，不要恢復整檔 JSON 歷史寫入。
- 大型檔案只以 `rg`／`sed` 精準讀取，避免無效上下文與測試輸出。
