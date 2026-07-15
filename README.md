# SmartHub — 家用網路/儲存/電源整合戰情室

Docker 容器管理的部署方式請見 [`NAS-DOCKER-MONITOR-SETUP.md`](NAS-DOCKER-MONITOR-SETUP.md)。

自架的全屋監控面板,把 **UniFi UCG-Ultra**(硬體/客戶端/WiFi/IPS 威脅/雲端)、**UGREEN UGOS Pro NAS**(CPU/硬碟/儲存/風扇/休眠)、**WiiM Amp** 串流音響、**CyberPower UPS** 電源、**AdGuard Home** DNS 防護與 **Linux 小主機** 整合到單一網頁。前後端分離,所有帳密金鑰僅存在後端 `.env`,前端不接觸任何上游 API。

- **前端**:`public/index.html` — 側邊欄 SPA,13 個分頁:總覽 / 客戶端 / 資安 / WiFi / 雲端站點 / UCG 閘道器 / NAS 儲存 / WiiM 音響 / UPS 電源 / AdGuard DNS / Linux 小主機 / 工具 / 通知推播 / 設定
- **後端**:`server.js`(Express,port 3000)— 資料來源:SSH×2、UniFi 本地 API、Site Manager 雲端 API、UGOS API、LinkPlay HTTP API、NUT/PowerPanel Business、AdGuard REST API
- **開發預覽**:`node server-mock.js`(port 3005,純假資料免設定)

主要功能:即時監控與歷史圖表(範圍 10 分鐘~7 天)、封鎖設備/關 WiFi/PoE 斷電、IPS 威脅戰情室與自動防禦、UPS 斷電事件記錄、硬碟休眠統計、客戶端自訂名稱、Discord/Telegram/Webhook 推播(56 種可獨立勾選的觸發條件)、定期報表、Structured Logging、System Diagnostics、頂部重大事件閃爍警報、PWA 手機安裝。

---

## 一、快速開始(3 分鐘跑起來)

```bash
git clone <你的 repo 網址> && cd unifi-smarthub

# 1. 建立專用設定目錄（必須存在且只放設定，不可掛整個 repository）
install -d -m 700 config
install -m 600 .env.example config/.env
nano config/.env # PANEL_PASSWORD 必填；再填需啟用的整合設定

# 2A. Docker 部署 (建議)
docker compose --env-file config/.env up -d --build
docker compose --env-file config/.env logs -f

# 2B. 或本機直接跑 (需 Node 20+)
npm install && SMARTHUB_ENV_FILE=config/.env npm start

# 3. 開瀏覽器
open http://<主機IP>:3000
```

> 沒填的設備區塊會顯示「未設定」並自動略過。網頁「設定 → 連線設定」會安全寫回 `config/.env`；一般整合會即時生效，NAS Monitor URL/key/mode 為同一個 recreate-scoped 信任組，變更後必須協調重建相關容器。

---

## 二、部署前準備的資料(依功能分組,全部選填)

| 分組 | 變數 | 說明 / 從哪裡拿 |
| :--- | :--- | :--- |
| **1. UCG 硬體監控 (SSH)** | `UCG_IP`, `SSH_USER`, `SSH_PASSWORD`, `SSH_PORT` | UniFi 主控台 → Console Settings → Advanced → **SSH** 開啟並設定專用密碼(不是 UniFi 登入密碼!) |
| | `WAN_IFACE` | WAN 網卡名,UCG-Ultra 通常 `eth4` |
| **2. UniFi 本地控制** | `UNIFI_CONTROLLER_URL` | UniFi OS 裝置通常 `https://<UCG_IP>` |
| | `UNIFI_USERNAME` / `UNIFI_PASSWORD` | **本地**管理員帳號(建議另開一組,別用 SSO 主帳號;要用封鎖功能需 Full Management 角色) |
| **3. UniFi 雲端** | `UNIFI_API_KEY` | [unifi.ui.com](https://unifi.ui.com) → API 建立。多站點/SD-WAN/ISP 指標 |
| **4. UGREEN NAS** | `NAS_HOST`, `NAS_USER`, `NAS_PASSWORD` | UGOS 管理員帳密(遙測 API 需管理員)。**密碼不可含 `#` `*` `§`**。`NAS_PORT`/`NAS_SCHEME` 預設 9443/https |
| **5. NAS Monitor 中介層** | `NAS_MONITOR_URL`, `NAS_MONITOR_API_KEY` | 選配的 Docker Monitor；內建版需明確啟用 `nas-monitor` profile |
| **6. WiiM 音響** | `WIIM_IP` | WiiM Amp 的區網 IP |
| **7. CyberPower UPS** | `UPS_SOURCE` | `auto`(依序試 PPB→NUT→pwrstat→pmset)或指定。**目前 Docker 已驗證路徑是 `ppb`,見下方第四節** |
| | `NUT_HOST`, `NUT_UPS_NAME` | NUT server 位置(容器內**不可**用 localhost) |
| **8. PowerPanel Business** | `PPB_HOST`, `PPB_PORT`, `PPB_USER`, `PPB_PASSWORD` | PPB 跑在哪台就填哪台的 IP(容器內不可 127.0.0.1) |
| **9. AdGuard Home** | `ADGUARD_HOST`, `ADGUARD_PORT`, `ADGUARD_USER`, `ADGUARD_PASSWORD` | AdGuard 管理帳密,啟用 DNS 防護頁 |
| **10. Linux 小主機** | `LINUX_HOST`, `LINUX_SSH_USER`, `LINUX_SSH_PASSWORD`, `LINUX_SSH_PORT` | 任何 Linux 主機的 SSH,啟用硬體監控頁 |
| **11. 面板密碼** | `PANEL_PASSWORD` | `NODE_ENV=production` 必填：整站 Basic Auth(帳號隨意、密碼為此值) |

> **安全提醒**:此面板具有斷網、關 WiFi、PoE 斷電、改 `.env` 等控制權限。只在內網部署、務必設 `PANEL_PASSWORD`,不要直接曝露到公網;遠端存取請走 VPN。

---

## 三、Docker Compose 部署邊界

預設 `docker compose up` 只啟動 SmartHub，不會綁定 Docker socket。`nas-monitor` 是 opt-in profile，也不是 SmartHub 啟動的強制依賴。完整 Compose 以專案內的 `docker-compose.yml` 為準，下列是重要部署保證：

```yaml
services:
  unifi-smarthub:
    stop_grace_period: 20s
    ports:
      - "${SMARTHUB_HOST_PORT:-3000}:3000"
    volumes:
      # 專用目錄讓同目錄 temp+fsync+rename 成立；不可改掛 repository root
      - type: bind
        source: ${SMARTHUB_CONFIG_DIR:-./config}
        target: /app/config
        bind:
          create_host_path: false

  nas-monitor:
    profiles: ["nas-monitor"]
    stop_grace_period: 20s
    user: "1000:1000"
    read_only: true
    cap_drop: ["ALL"]
    security_opt: ["no-new-privileges:true"]
```

image 內建 healthcheck 對 `/health/ready` 發出最多 4 秒的 request，Docker 再以 5 秒強制截止。兩個 image 都使用 `SIGTERM`，Compose 給 20 秒 graceful-stop 時間。本專案不固定 `container_name`，volume 與容器名會跟 Compose project 隔離；同一主機部署多份時，每份都要有獨立 config 目錄，且 `SMARTHUB_CONFIG_DIR` 必須指向同一個 `--env-file` 所在目錄：

```bash
docker compose --env-file config-prod/.env -p smarthub-prod up -d --build
docker compose --env-file config-lab/.env -p smarthub-lab up -d --build
```

上線前用 `docker compose --env-file config/.env config --quiet` 驗證結構；請勿輸出已展開的 config，因為其中可能含機密。每次 Compose 操作都使用同一個 `--env-file`；根目錄不要再保留另一份 `.env`，否則會重新產生雙重 authority。

此基線使用 Compose profiles、long bind `create_host_path: false` 與 Docker Engine `host-gateway`；老舊 NAS 內建的 Compose v1/Engine 若不支援，應先升級，不要刪掉 fail-closed 或 PPB host mapping 設定來迴避。

正式 release 不要從 dirty checkout 直接覆蓋 `latest`。先完成測試與 commit，再執行 `npm run release:build`；它會拒絕 staged/unstaged/untracked 差異，從 `git archive HEAD` 先建置並驗證兩個 staging image，再成對發布 revision tag；既有 revision tag 一律拒絕重指向，第二個 tag 發布失敗時會回滾第一個。它也會核對 OCI version/revision/created/dirty labels。local tag 仍不是 registry digest，部署證據應另記錄 image ID/digest。把輸出的 image 名稱設為 `SMARTHUB_IMAGE` / `NAS_MONITOR_IMAGE`，再用 `docker compose --env-file config/.env up -d --no-build --pull never` rehearsal。普通開發 build 的 `/health` 會標示 incomplete，不能當正式 release 證據。

**部署檢查清單**:

1. ☑ `config/` 為專用目錄、`config/.env` 是 regular file，目錄可讓 container UID 1000 建立/rename temp；檔案權限為 `0600`
2. ☑ `TZ` 改成你的時區
3. ☑ `config/.env` 內已設 `PANEL_PASSWORD`，所有 Compose 指令都帶同一個 `--env-file config/.env`
4. ☑ UPS 來源已照第四節設定(容器內 pwrstat/pmset 不可用)
5. ☑ 所有 `*_HOST` 都是**實際 IP**,沒有任何 localhost/127.0.0.1(容器內的 localhost 是容器自己)
6. ☑ 只有需要 Docker 管理時才照 `NAS-DOCKER-MONITOR-SETUP.md` 啟用 monitor profile

---

## 四、UPS 在 Docker 裡的正確接法(最常踩的坑)

`UPS_SOURCE=auto` 的四個來源中,**pwrstat 與 pmset 在容器內不存在**,只剩兩條路:

**方案 A — PowerPanel Business(目前 Docker 已驗證路徑)**

1. 宿主機跑 CyberPower PowerPanel Business，REST discovery port 使用預設 `3052`
2. `config/.env` 設:`UPS_SOURCE=ppb`、`PPB_HOST=host.docker.internal`、`PPB_PORT=3052`，並填 `PPB_USER`/`PPB_PASSWORD`
3. Compose 已保留 `host.docker.internal:host-gateway` mapping，可同時適用 Docker Desktop/OrbStack 與新版 Linux Engine。不要在容器內改用 `pwrstat`

**方案 B — NUT(UPS USB 接 NAS 且已有 NUT server 時)**

1. 在跑 Docker 的主機(NAS)上安裝並設定 NUT server,UPS USB 接這台
2. 容器已內建 `upsc` 客戶端(Dockerfile 已裝 `nut`)
3. `config/.env` 設:`UPS_SOURCE=nut`、`NUT_HOST=<NAS 的區網 IP>`(不能 localhost)、`NUT_UPS_NAME=<ups.conf 裡的名稱>`

啟動後看 `docker compose logs | grep Diag`,UPS 那行會直接告訴你連上了沒、失敗原因為何。

---

## Telegram 指令中心

到「通知推播」選擇 Telegram，填入 Bot Token 與 Chat ID 後勾選「啟用 Telegram 指令中心」。Bot 使用 long polling 主動連線 Telegram，不需要開放 webhook port。它只接受設定中的單一 Chat ID；控制指令還要在 60 秒內輸入一次性確認碼。

常用查詢：`/status`（完整 24H 報表）、`/health`、`/network`、`/clients [關鍵字]`、`/threats`、`/nas`、`/docker [名稱]`、`/ups`、`/wiim`、`/alerts`。控制指令：`/speedtest`、`/docker_restart <名稱>`、`/wiim_toggle`、`/wiim_stop`、`/wiim_volume <0-100>`。傳送 `/help` 可在 Telegram 內查看完整清單。

若同一個 Bot Token 被另一個程式或 webhook 同時接收更新，Telegram 的 `getUpdates` 會互相競爭；請讓 SmartHub 獨占該 Bot，或另外向 BotFather 建一個 Bot。

---

## 五、歷史資料與持久化

**統計資料使用 SQLite，資料庫檔 `smarthub.db` 存於 volume `smarthub-data`**。設定類資料仍使用 JSON，方便人工檢查與編輯。

| 類別 | 檔案 | 說明 |
| :--- | :--- | :--- |
| 歷史序列 | `smarthub.db` 的 `history` table | 六組時間序列，WAL + 索引查詢，**保存天數統一由設定頁控制(預設 30 天)** |
| 事件 | `smarthub.db` 的 `ups_events` / `block_history` | 斷電事件與封鎖時間軸，SQLite transaction 即時寫入 |
| 設定 | `app-settings / security-settings / notification-settings / client-aliases .json` | 取樣間隔、報表、推播、客戶端別名 |

**寫入策略**:一般歷史樣本先放入有上限的記憶體 queue，預設每 10 分鐘（或累積 1,000 筆 / 1 MiB）以單一 SQLite transaction 批次寫入 WAL。查詢會合併尚未落盤的資料；正常關機與 UPS 斷電轉態會強制 flush。UPS 斷電事件、封鎖紀錄、報表及 NAS 日誌手機推播不經過此緩衝。資料庫每小時清理過期資料並執行增量 vacuum。

**取樣頻率是裝置感知的自適應模式**:總覽或 UCG／NAS／WiiM／UPS／AdGuard／Linux 設備頁可見時，該頁全部前端資訊每 3 秒更新；總覽會同步加速其顯示的 UCG、NAS、WiiM 與趨勢後端取樣。切頁會立即撤銷上一個設備 scope，分頁進背景也主動釋放；心跳意外中斷時仍有伺服器短租約保護，租約到期即回到各項原本預設。UPS 的斷電歷史取樣獨立持續運作，不因頁面狀態降頻。

備份:
```bash
docker volume ls --filter label=com.docker.compose.volume=smarthub-data --format '{{.Name}}'
# 從上一行確認正確 project 的 volume 後再替換 <volume-name>；自訂 -p 時名稱會不同。
docker run --rm -v <volume-name>:/d:ro -v "$PWD":/b alpine \
  tar czf /b/smarthub-backup.tar.gz -C /d .
```

備份時需包含 `smarthub.db`、`smarthub.db-wal`、`smarthub.db-shm`（上述停止容器後備份的方式會完整包含）。若服務仍在執行，請先停止容器，或使用 SQLite 的 `VACUUM INTO` 產生一致性備份。

---

## 六、驗證部署成功

1. **健康檢查**:`curl http://<主機IP>:3000/health` → `{"status":"healthy",...}`；`curl http://<主機IP>:3000/health/ready` 會再檢查 SQLite/worker；`docker compose --env-file config/.env ps` 應為 `healthy`
2. **啟動連線診斷**(最快的除錯方式):
   ```bash
   docker compose --env-file config/.env logs | grep Diag
   ```
   啟動 3 秒後會逐台測試並輸出,例如:
   ```
   ✅ UCG SSH (192.168.0.1:22)：CPU 54°C，正常
   ✅ UniFi 控制器：登入成功
   ❌ UPS：所有來源皆無法讀取 (已嘗試: ppb, nut, ...)
      Docker 環境 UPS 檢查清單：(1) UPS_SOURCE=ppb + PPB_HOST=host.docker.internal + PPB_PORT=3052
   ⚠️ NUT_HOST=localhost：容器內的 localhost 是容器自己，請改成實際 IP
   ```
3. **網頁確認**:「設定 → System Diagnostics」顯示本服務 CPU/RAM/disk/SQLite/worker 與 Active Issues；「目前連線狀態」列出外部設備狀態

---

## 七、疑難排解

| 現象 | 處理 |
| :--- | :--- |
| Compose 回報 `config` / `.env` 不存在 | 執行 `install -d -m 700 config && install -m 600 .env.example config/.env`，並確認指令帶 `--env-file config/.env` |
| 舊版根目錄 `.env` 部署要升級 | 先停服務，再 `install -d -m 700 config && mv .env config/.env && chmod 600 config/.env`；必要時將 `config/` owner/ACL 調整成 container UID 1000 可建立檔案，之後不要保留第二份 root `.env` |
| 某設備連不上 | 先看 `docker compose logs \| grep Diag`,每台的失敗原因(DNS/逾時/認證/埠拒絕)都有分類提示 |
| 全部設備連不上 | 檢查 `config/.env` 裡是否有 `localhost`/`127.0.0.1` —— 容器內連不到宿主機或其他設備 |
| SSH 硬體頁失敗 | UCG 的 SSH 密碼是**獨立設定**的,不是 UniFi 登入密碼;主控台 → Console Settings → Advanced → SSH |
| 封鎖設備回 NoPermission | UniFi 本地帳號是唯讀角色,到 Admins 改為 Full Management |
| 報表在錯的時間發送 | compose 的 `TZ` 沒設或設錯 |
| 打開網頁跳登入框 | `PANEL_PASSWORD` 已設定,帳號隨意、密碼填該值 |
| 雲端頁顯示未設定 | `UNIFI_API_KEY` 未填,屬正常回退 |
| NAS 欄位顯示 `--` | NAS 頁底部「Raw JSON」對照實際欄位名回報即可修 |
| UPS 事件「通訊中斷」頻繁 | macOS 電源管理與 PowerPanel 搶 USB HID 的已知問題,見 `cyberpower-ups-api.md` |
| build 出現 cpu-features 警告 | 可忽略,ssh2 的選用加速模組,缺了走純 JS 一樣正常 |

---

## 八、常用維運指令

```bash
docker compose --env-file config/.env logs -f
docker compose --env-file config/.env logs | grep Diag
docker compose --env-file config/.env logs unifi-smarthub | grep 'ERROR\|CRITICAL'
docker compose --env-file config/.env restart
npm run release:build                 # clean HEAD → revision-tagged images + label verification
docker compose --env-file config/.env up -d --build # 僅供本機開發；identity 為 incomplete
docker compose --env-file config/.env down          # 停止 (歷史資料保留在 volume)
docker volume ls                      # 確認 smarthub-data 存在
```

---

## 附錄

- `AGENTS.md` / `CLAUDE.md` — 精簡 AI 工作入口與讀檔路由
- `ROADMAP.md` — 未使用 API 盤點與功能路線圖
- `OBSERVABILITY.md` — Structured Logging、Status Code、Health/Diagnostics API、監控門檻與 Docker 除錯
- `*-api.md` — UniFi / UGREEN / WiiM / CyberPower 各 API 規格參考
