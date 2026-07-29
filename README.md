# SmartHub 家用基礎設施戰情室

SmartHub 是自架的 Node.js／Express 管理面板，整合 UniFi、UCG、UGREEN NAS、Docker、WiiM、CyberPower UPS、AdGuard Home、Linux 主機與多種通知管道。正式環境使用 Docker；前端不直接接觸上游帳密或 API key。

- 正式服務：`server.js`，port `3000`
- 開發假資料：`server-mock.js`，port `3005`
- 歷史資料：SQLite `data/smarthub.db`
- 目前版本：`3.0.0`
- 文件索引：[docs/README.md](docs/README.md)
- 正式發布：[docs/operations/PRODUCTION-RELEASE-CHECKLIST.md](docs/operations/PRODUCTION-RELEASE-CHECKLIST.md)
- 最終驗證：[docs/reports/PRODUCTION_READINESS_REPORT.md](docs/reports/PRODUCTION_READINESS_REPORT.md)

## 主要能力

- 14 個頁面：總覽、UCG、客戶端、資安、WiFi、雲端站點、NAS、WiiM、UPS、AdGuard、Linux、工具、通知、設定。
- 3 秒活動頁更新與後端自適應取樣；離開頁面後自動回到低頻。
- 管理員／唯讀角色、Session、CSRF、Origin 檢查、登入節流與受保護寫入路由。
- SQLite 歷史、事件、報表、政策、Web Push、備份／還原與重啟復原。
- Discord、Telegram、Webhook、Web Push 與 Telegram 指令中心。
- 可選的 NAS Monitor；Docker 操作與日誌各自使用明確 allowlist。

## 快速開始

需求：Node.js 20+；正式部署另需 Docker Compose。

```bash
git clone <repository-url>
cd unifi-smarthub

install -d -m 700 config
install -m 600 .env.example config/.env
# 編輯 config/.env，正式環境至少設定 PANEL_PASSWORD

npm ci
docker compose --env-file config/.env up -d --build
docker compose --env-file config/.env ps
```

開啟 `http://<主機 IP>:3000`。

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
| UCG SSH | `UCG_IP`, `SSH_USER`, `SSH_PASSWORD` |
| UniFi 本地 | `UNIFI_CONTROLLER_URL`, `UNIFI_USERNAME`, `UNIFI_PASSWORD` |
| UniFi 雲端 | `UNIFI_API_KEY` |
| UGREEN NAS | `NAS_HOST`, `NAS_USER`, `NAS_PASSWORD` |
| NAS Monitor | `NAS_MONITOR_URL`, `NAS_MONITOR_API_KEY`, `NAS_MONITOR_MODE` |
| WiiM | `WIIM_IP` |
| UPS | `UPS_SOURCE` 與對應的 `PPB_*`／`NUT_*`；PPB TLS 見下節 |
| AdGuard | `ADGUARD_URL`, `ADGUARD_USER`, `ADGUARD_PASSWORD` |
| Linux SSH | `LINUX_HOST`, `LINUX_SSH_USER`, `LINUX_SSH_PASSWORD` |
| 面板登入 | `PANEL_PASSWORD`；唯讀帳號另設 `PANEL_READONLY_*` |

沒有設定的整合會顯示未設定或空狀態，不應阻止主服務就緒。

## 安全與部署邊界

- 只部署在可信任內網；遠端存取使用 VPN 或受信任反向代理。
- `config/.env` 是唯一部署設定來源，權限應為 `0600`；不要在根目錄保留第二份 `.env`。
- 所有 Compose 指令都使用同一個 `--env-file config/.env`。
- `nas-monitor` 預設不啟用。可寫 Docker socket 等同宿主機 root 權限；詳見 [Docker 容器管理指南](docs/operations/NAS-DOCKER-MONITOR-SETUP.md)。
- 前端依賴與 WiFi QR 均由 SmartHub 同源提供，不把 SSID、密碼或遙測送往第三方服務。
- Dashboard JavaScript 全部由同源外部檔案載入；CSP 的 `script-src` 只有 `'self'`，不允許 inline script、inline handler 或 `unsafe-eval`。
- 正式映像不可從 dirty checkout、`latest` 或臨時 `--build` 直接發布。

## Docker UPS

已驗證路徑是 PowerPanel Business REST：

```env
UPS_SOURCE=ppb
PPB_HOST=host.docker.internal
PPB_PORT=3052
PPB_USER=...
PPB_PASSWORD=...
PPB_TLS_VERIFY=true
PPB_TLS_INSECURE=false
# 私有／自簽 CA 建議掛載後使用：
# PPB_CA_FILE=/app/config/ppb-ca.pem
```

未設定 TLS 新欄位時仍會驗證憑證。只有明確設定 `PPB_TLS_INSECURE=true` 才會停用驗證並產生警告；`PPB_TLS_VERIFY=false` 不會單獨關閉驗證。CA 必須是容器內可讀的絕對路徑、一般檔案且不得為 symlink。

容器內沒有宿主機的 `pwrstat` 或 `pmset`。替代方案是讓容器連到可達的 NUT server；詳見 [UPS 整合摘要](docs/integrations/cyberpower-ups-api.md)。

## 資料與備份

- Docker volume `/app/data` 是正式 runtime 權威來源。
- 歷史、事件、報表與政策使用 SQLite WAL。
- 一般歷史樣本先進入有上限的記憶體佇列，再批次寫入；正常關機與 UPS 狀態轉換會強制 flush。
- 線上安全備份由「設定 → 備份與還原」產生，不包含 secret。
- 完整離線備份應先停止服務，再保存 DB／WAL／SHM 與設定。

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
| `/api/public/system-health` | 登入頁匿名最小狀態快照 |
| `/api/system/status` | 受驗證保護的完整診斷 |

## 正式發布

Pull Request 會執行 GitHub Actions workflow `SmartHub CI`，其 check 名稱為 `Repository gate`。Repository 管理員應在 `main` branch protection／ruleset 將 `SmartHub CI / Repository gate` 設為 Required Check，並禁止 CI 未通過的 PR merge；若尚未設定，不能把 workflow 存在誤稱為 branch protection 已啟用。

先依 [正式發布檢查清單](docs/operations/PRODUCTION-RELEASE-CHECKLIST.md) 執行必要 gate，再建立不可變成對映像：

```bash
npm run release:build
docker compose --env-file config/.env up -d --no-build --pull never
```

`release:build` 會拒絕 dirty worktree，並驗證 SmartHub／NAS Monitor 的版本、revision 與映像身分。若使用 registry，仍需另外記錄不可變 digest。

## 開發原則

- 先讀 `CONTEXT.md`，再依任務讀 `SERVER-MAP.md` 或 `FRONTEND-MAP.md`。
- 修改前端可見 API／設定時，同步 `server-mock.js` 與契約測試。
- 新歷史資料沿用 `db.js`，不要恢復整檔 JSON 歷史寫入。
- 大型檔案只以 `rg`／`sed` 精準讀取，避免無效上下文與測試輸出。
