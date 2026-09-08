# SmartHub 家用基礎設施戰情室

SmartHub 是自架的 Node.js／Express 管理面板，整合 UniFi、UCG、UGREEN NAS、Docker、WiiM、CyberPower UPS、AdGuard Home、Linux 主機與多種通知管道。正式環境使用 Docker；前端不直接接觸上游帳密或 API key。

- 正式服務：`server.js`，port `3000`
- 開發假資料：`server-mock.js`，port `3005`
- 歷史資料：SQLite `data/smarthub.db`
- 目前版本：`3.0.0`
- AI／Claude Code 低上下文入口：[CLAUDE.md](CLAUDE.md)；任務分流：[CONTEXT.md](CONTEXT.md)
- 文件索引：[docs/README.md](docs/README.md)
- 完整操作與文件規格：[SMARTHUB_COMPLETE_OPERATION_MANUAL_ZH_TW.html](SMARTHUB_COMPLETE_OPERATION_MANUAL_ZH_TW.html)
- 正式發布：[docs/operations/PRODUCTION-RELEASE-CHECKLIST.md](docs/operations/PRODUCTION-RELEASE-CHECKLIST.md)
- 最新 production blocker 記錄：[docs/reports/PRODUCTION_RELEASE_BLOCKERS_20260907.md](docs/reports/PRODUCTION_RELEASE_BLOCKERS_20260907.md)
- 歷史 production readiness：[docs/reports/PRODUCTION_READINESS_REPORT.md](docs/reports/PRODUCTION_READINESS_REPORT.md)
- 長期硬化報告：[docs/reports/PRODUCTION_LONG_RUN_HARDENING_REPORT.md](docs/reports/PRODUCTION_LONG_RUN_HARDENING_REPORT.md)
- Post-merge audit：[docs/reports/POST_MERGE_AUDIT_HARDENING.md](docs/reports/POST_MERGE_AUDIT_HARDENING.md)
- Production-like staging 驗收：[docs/operations/PRODUCTION-STAGING-ACCEPTANCE.md](docs/operations/PRODUCTION-STAGING-ACCEPTANCE.md)
- 歷史 Production Acceptance：[docs/operations/PRODUCTION_ACCEPTANCE.md](docs/operations/PRODUCTION_ACCEPTANCE.md)

## 主要能力

- 14 個頁面：總覽、UCG、客戶端、資安、WiFi、雲端站點、NAS、WiiM、UPS、AdGuard、Linux、工具、通知、設定。
- 設定驅動的活動頁更新與後端自適應取樣；一般裝置預設 5 秒、UPS 即時狀態預設 3 秒，離開頁面後自動回到低頻。
- UCG 頁提供 UniFi 裝置 Controller 遙測與可選的唯讀 Device SSH 真實溫度；不支援時明確顯示「不支援」，不推算或偽造溫度。
- 管理員／唯讀角色、Session、CSRF、Origin 檢查、登入節流與受保護寫入路由。
- SQLite 歷史、事件、報表、政策、Web Push、備份／還原與重啟復原。
- Discord、Telegram、Webhook、Web Push 與 Telegram 指令中心。
- 可選的 NAS Monitor；Docker 操作與日誌各自使用明確 allowlist。

## AI 修改流程（低上下文）

AI 工作一開始只讀 `CLAUDE.md` 與 `CONTEXT.md`，再依任務選一份 reference map；不要先讀整個 repository。後端先看 [backend-map.md](docs/reference/backend-map.md)，前端先看 [frontend-map.md](docs/reference/frontend-map.md)，部署才看本 README 與 [正式發布檢查清單](docs/operations/PRODUCTION-RELEASE-CHECKLIST.md)。大型 source、`data/`、`.env`、依賴與歷史報告都採按需精讀；先用 `rg` 定位，再讀行號區段。這套流程是為了避免每次對話把整個專案重複送入上下文。

## 快速開始

需求：正式部署需要 Docker Compose；只有從 source 本機建置才需要 Node.js 24.18.x（`.nvmrc`）。

### NAS 使用 GHCR 映像（一般更新路徑）

GitHub repository 是原始碼來源，GHCR 才是 NAS 要拉取的 container image registry。第一次部署仍需把 Compose、更新腳本與 `config/.env` 放到 NAS；之後 GitHub Actions 會在 `main` 或 `vX.Y.Z` tag 通過 `SmartHub CI` 後發布成對的 multi-arch image。`stable` 是方便自動更新的移動 channel；`vX.Y.Z` 是給 NAS 指定版本的 release tag；若要最高可稽核／可回滾保證，將兩個 image ref 改成同一個 release 的 digest。

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
# 編輯 config/.env，正式環境設定至少 16 字元且非 placeholder 的 PANEL_PASSWORD

# 私有 repository／GHCR package 必須先登入；token 只需 read:packages。
read -r -s GHCR_READ_TOKEN
printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io \
  --username <github-username> --password-stdin
unset GHCR_READ_TOKEN

# 第一次使用全新的 smarthub-data volume 才加 --initialize；既有 DB 會拒絕初始化。
./scripts/update-nas.sh --tag stable --initialize
# 使用 stable 更新：只需重新拉取並以新 image 重建：
./scripts/update-nas.sh
# 使用 GitHub 發布的固定 tag 更新（SmartHub 與 NAS Monitor 會使用同一 tag）：
./scripts/update-nas.sh --tag v3.0.1
# 啟用 Docker Monitor 時：
# ./scripts/update-nas.sh --tag v3.0.1 --profile nas-monitor
```

GitHub Actions 尚未成功發布對應 tag 前，`pull` 會正常失敗；先確認 `SmartHub CI` 與 `Publish SmartHub images` 都成功。私有 repository 不會讓 NAS 自動取得權限；NAS 使用的 GitHub PAT（classic）應只給 `read:packages`，不要把它寫入 repository、`config/.env` 或命令列歷史。也可以在 `config/.env` 只填一個 `SMARTHUB_IMAGE_TAG=v3.0.1`，之後執行不帶 `--tag` 的腳本；若同時存在舊的完整 `SMARTHUB_IMAGE`／`NAS_MONITOR_IMAGE`，`--tag` 會以當次命令覆蓋它們。

### GitHub 發布方式

合併到 `main` 並等待 `SmartHub CI` 成功後，Actions 會發布 `stable` 與 `sha-<commit>`。要讓 NAS 使用固定版本，從已通過檢查的 `main` commit 建立並推送版本 tag：

```bash
git tag -a v3.0.1 -m "SmartHub v3.0.1"
git push origin v3.0.1
```

`v3.0.1` push 會先觸發完整 `SmartHub CI`，只有 exact CI head 成功後才發布 `v3.0.1` 與配對的 `-nas-monitor:v3.0.1`；NAS 再執行 `./scripts/update-nas.sh --tag v3.0.1`。不要重用或強制移動已部署的 release tag；需要可驗證的回滾時，記錄兩個 image digest。

### 本機從 source 建置

需要修改 source 或離線 build 時，使用明確的 build overlay；正式 NAS 不使用這個 overlay：

```bash
npm ci
docker compose --env-file config/.env \
  -f docker-compose.yml -f docker-compose.build.yml build unifi-smarthub
docker compose --env-file config/.env \
  -f docker-compose.yml -f docker-compose.build.yml --profile nas-monitor build
# 僅第一次使用全新的 smarthub-data volume 時執行一次；既有資料庫不要覆蓋。
docker compose --env-file config/.env \
  -f docker-compose.yml -f docker-compose.build.yml run --rm --no-deps \
  unifi-smarthub node -e "const { createHistoryDb } = require('./db'); const db = createHistoryDb(process.env.DATA_DIR); db.close();"
docker compose --env-file config/.env \
  -f docker-compose.yml -f docker-compose.build.yml run --rm --no-deps \
  unifi-smarthub node scripts/production-preflight.js --offline
docker compose --env-file config/.env \
  -f docker-compose.yml -f docker-compose.build.yml up -d --no-build --pull never
docker compose --env-file config/.env \
  -f docker-compose.yml -f docker-compose.build.yml ps
```

本機隔離演練可開啟 `http://127.0.0.1:3000`。正式環境不可把 `http://<NAS IP>:3000` 當作對外入口；請以前置 Caddy／Nginx 終止 HTTPS，再反向代理至 SmartHub 的內部 port。

### 可信任內網最簡部署

1. `cp .env.example config/.env`
2. 保留安全預設 `TRUSTED_LAN_MODE=false`，只填設備 IP、帳號與密碼；若明確接受私有設備的相容風險，才設定為 `true`。
3. `docker compose --env-file config/.env build unifi-smarthub`
4. `docker compose --env-file config/.env run --rm --no-deps unifi-smarthub node scripts/production-preflight.js --offline`
5. `docker compose --env-file config/.env up -d --no-build`
6. `docker compose --env-file config/.env ps`
7. 檢查 `/health`、`/health/ready` 與設定頁的整合狀態。

`TRUSTED_LAN_MODE` 是 compatibility master switch，安全預設為 `false`。公開部署應維持關閉並使用正式 CA／SSH fingerprint；若明確設為 `true`，安全 baseline（TLS verify=true、insecure=false、HTTP=false、SSH unpinned=false）只會在私有 IP、loopback、`host.docker.internal` 與 `TRUSTED_LAN_HOSTS` 完全相符的 hostname 上產生 scoped 自簽 TLS、私有 HTTP 與 SSH Host Key 相容傳輸。關閉模式後不會自動接受 self-signed TLS、HTTP 或 unpinned SSH；未 pin 的 Trusted LAN SSH 會留下可觀測 warning。若另設 legacy/manual insecure override，狀態會顯示 `explicitly-insecure`／`explicit-insecure-http`，不會冒充 Trusted LAN。configured CA／SSH fingerprint 永遠優先。它絕不影響 Site Manager、Telegram、Discord、Webhook、外部圖片/CDN 或其他 Internet integration 的 TLS 驗證。

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
- 本機 source gate 順序固定為 `build overlay` → `production-preflight.js --offline` → `up -d --no-build --pull never`；GHCR/NAS 更新則為 `config` → `pull` → `production-preflight.js --offline` → `up -d --no-build --pull never`。preflight 不得在 image 就緒前執行，也不得以 `up --build` 繞過已驗證映像。
- 所有 Compose 指令都使用同一個 `--env-file config/.env`。
- GHCR 會同時發布不可變的 `sha-<commit>` tag；`main` 另發布 `stable`，版本 tag（例如 `v3.0.1`）則由 tag push 的 exact CI head 發布。高保證部署使用 registry digest，不使用 `latest`。主服務預設 256 MiB，只有在 soak／backup 證據支持時才調整。
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
- `scripts/update-nas.sh` 只替換 image；它會記錄現有容器的 `/app/data` volume identity，若 Compose project／目錄變更造成 volume identity 改變就拒絕宣稱更新成功。更新時保持同一個部署目錄與 Compose project，不要對既有資料使用 `--initialize`。
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

`main` 的 `SmartHub CI` 成功後，`Publish SmartHub images` 會 checkout 同一個 CI head，發布 `ghcr.io/steven87090799/unifi-smarthub:sha-<commit>`、`:stable` 與配對的 `-nas-monitor` image；推送 `vX.Y.Z` tag 時，則發布 `:vX.Y.Z` 與同一 revision 的 `:sha-<commit>`。兩種路徑都支援 `linux/amd64`、`linux/arm64`。這是 image 發布證據，不等於 NAS 實機驗收；NAS 更新仍應保留 health、SQLite、restart 與 rollback 證據。

本機也可獨立重跑同一個隔離 smoke：

```bash
npm run test:smoke
```

`main` branch protection 已將 `Repository gate`（UI 顯示 `SmartHub CI / Repository gate`）設為 strict／up-to-date Required Check，並由管理員 enforcement 保護；若日後讀回缺失，不能把 workflow 存在誤稱為 branch protection 已啟用。

先依 [正式發布檢查清單](docs/operations/PRODUCTION-RELEASE-CHECKLIST.md) 執行必要 gate；`npm run release:build` 是本機 clean paired-image identity/reproducibility 檢查，正常 GitHub → GHCR 發布由 `Publish SmartHub images` 完成：

```bash
npm run release:build
# GHCR workflow 的成對 registry digest 寫入 config/.env，或使用 GHCR stable channel：
# SMARTHUB_IMAGE=ghcr.io/steven87090799/unifi-smarthub@sha256:<digest>
# NAS_MONITOR_IMAGE=ghcr.io/steven87090799/unifi-smarthub-nas-monitor@sha256:<digest>
docker compose --env-file config/.env run --rm --no-deps \
  unifi-smarthub node scripts/production-preflight.js --offline
docker compose --env-file config/.env up -d --no-build --pull never
```

`release:build` 會拒絕 dirty worktree，並驗證 SmartHub／NAS Monitor 的版本、revision、image ID 與映像身分。若使用 registry，仍需成對記錄不可變 digest；部署時保留 release JSON 的 `image_ids` 與 registry digest，不能只記錄可重指向的 tag。

Dockerfile 的 release 供應鏈目前固定為 Node `24.18.0-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd`，直接使用的 Alpine 套件也固定為 `tini=0.19.0-r3`、`nut=2.8.3-r4`、`libcrypto3=3.5.8-r0`、`libssl3=3.5.8-r0`、`tzdata=2026c-r0`，以及 build dependencies `python3=3.14.7-r1`、`make=4.4.1-r4`、`g++=15.2.0-r5`。更新任一 pin 時，必須連同 base digest、SBOM、Trivy 報告與成對 image IDs 一起刷新。

## 開發原則

- 先讀 `CONTEXT.md`，再依任務讀 `docs/reference/backend-map.md` 或 `docs/reference/frontend-map.md`。
- 修改前端可見 API／設定時，同步 `server-mock.js` 與契約測試。
- 新歷史資料沿用 `db.js`，不要恢復整檔 JSON 歷史寫入。
- 大型檔案只以 `rg`／`sed` 精準讀取，避免無效上下文與測試輸出。
