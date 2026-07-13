# SmartHub — 家用網路/儲存/電源整合戰情室

自架的全屋監控面板,把 **UniFi UCG-Ultra**(硬體/客戶端/WiFi/IPS 威脅/雲端)、**UGREEN UGOS Pro NAS**(CPU/硬碟/儲存/風扇/休眠)、**WiiM Amp** 串流音響、**CyberPower UPS** 電源、**AdGuard Home** DNS 防護與 **Linux 小主機** 整合到單一網頁。前後端分離,所有帳密金鑰僅存在後端 `.env`,前端不接觸任何上游 API。

- **前端**:`public/index.html` — 側邊欄 SPA,13 個分頁:總覽 / 客戶端 / 資安 / WiFi / 雲端站點 / UCG 閘道器 / NAS 儲存 / WiiM 音響 / UPS 電源 / AdGuard DNS / Linux 小主機 / 工具 / 通知推播 / 設定
- **後端**:`server.js`(Express,port 3000)— 資料來源:SSH×2、UniFi 本地 API、Site Manager 雲端 API、UGOS API、LinkPlay HTTP API、NUT/PowerPanel Business、AdGuard REST API
- **開發預覽**:`node server-mock.js`(port 3005,純假資料免設定)

主要功能:即時監控與歷史圖表(範圍 10 分鐘~7 天)、封鎖設備/關 WiFi/PoE 斷電、IPS 威脅戰情室與自動防禦、UPS 斷電事件記錄、硬碟休眠統計、客戶端自訂名稱、Discord/Telegram/Webhook 推播(20+ 種觸發條件)、定期報表、Structured Logging、System Diagnostics、頂部重大事件閃爍警報、PWA 手機安裝。

---

## 一、快速開始(3 分鐘跑起來)

```bash
git clone <你的 repo 網址> && cd unifi-smarthub

# 1. 建立設定檔 (Docker 部署「必須」先做這步，否則 bind mount 會建立成資料夾)
cp .env.example .env
nano .env        # 至少填第 1、2 組 (UCG SSH + UniFi 帳密)，其他都可以之後再補

# 2A. Docker 部署 (建議)
docker compose up -d --build
docker compose logs -f      # 看啟動診斷：每台設備會列出 ✅/❌ 與失敗原因

# 2B. 或本機直接跑 (需 Node 20+)
npm install && npm start

# 3. 開瀏覽器
open http://<主機IP>:3000
```

> 沒填的設備區塊會顯示「未設定」並自動略過,面板照常運作;**之後可以直接在網頁「設定 → 連線設定」補填,免重啟即時生效**(會寫回 `.env`)。

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
| **5. NAS Monitor 中介層** | `NAS_MONITOR_URL`, `NAS_MONITOR_API_KEY` | 選配的 Flask 中介層,啟用 Docker 管理/警報閾值/SSE 即時推送 |
| **6. WiiM 音響** | `WIIM_IP` | WiiM Amp 的區網 IP |
| **7. CyberPower UPS** | `UPS_SOURCE` | `auto`(依序試 PPB→NUT→pwrstat→pmset)或指定。**Docker 部署建議 `nut`,見下方第四節** |
| | `NUT_HOST`, `NUT_UPS_NAME` | NUT server 位置(容器內**不可**用 localhost) |
| **8. PowerPanel Business** | `PPB_HOST`, `PPB_PORT`, `PPB_USER`, `PPB_PASSWORD` | PPB 跑在哪台就填哪台的 IP(容器內不可 127.0.0.1) |
| **9. AdGuard Home** | `ADGUARD_HOST`, `ADGUARD_PORT`, `ADGUARD_USER`, `ADGUARD_PASSWORD` | AdGuard 管理帳密,啟用 DNS 防護頁 |
| **10. Linux 小主機** | `LINUX_HOST`, `LINUX_SSH_USER`, `LINUX_SSH_PASSWORD`, `LINUX_SSH_PORT` | 任何 Linux 主機的 SSH,啟用硬體監控頁 |
| **11. 面板密碼** | `PANEL_PASSWORD` | **部署到 NAS 強烈建議設定**:整站 Basic Auth(帳號隨意、密碼為此值) |

> **安全提醒**:此面板具有斷網、關 WiFi、PoE 斷電、改 `.env` 等控制權限。只在內網部署、務必設 `PANEL_PASSWORD`,不要直接曝露到公網;遠端存取請走 VPN。

---

## 三、docker-compose.yml 完整說明

專案內附的 `docker-compose.yml` 已經是完整可用版,逐段說明(標 ⚙️ 的是你可能要改的):

```yaml
services:
  unifi-smarthub:
    build: .                          # 用專案內 Dockerfile 建置
    image: unifi-smarthub:latest
    container_name: unifi-smarthub
    restart: unless-stopped           # 開機自啟、當機自動重啟

    ports:
      - "3000:3000"                   # ⚙️ 對外埠。想改 8080 → "8080:3000"

    env_file:
      - .env                          # 所有帳密由此注入 (檔案必須存在!)

    environment:
      - NODE_ENV=production
      - DATA_DIR=/app/data
      - TZ=Asia/Taipei                # ⚙️ 時區。不設會是 UTC，報表發送時間差 8 小時

    volumes:
      # 歷史資料持久化：重建容器/更新版本都不會遺失
      - smarthub-data:/app/data
      # .env 掛回宿主機：網頁「連線設定」的修改才能跨重建保留
      - ./.env:/app/.env

    mem_limit: 256m                   # ⚙️ 記憶體上限 (實測常駐 60-120MB，充裕)
    mem_reservation: 128m

    healthcheck:                      # 容器自我健康檢查 (輕量 /health liveness)
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3

volumes:
  smarthub-data:
```

**部署檢查清單**:
1. ☑ `cp .env.example .env` 已做(否則 `./.env` bind mount 會被 Docker 建立成**資料夾**,啟動就掛)
2. ☑ `TZ` 改成你的時區
3. ☑ `.env` 內已設 `PANEL_PASSWORD`
4. ☑ UPS 來源已照第四節設定(容器內 pwrstat/pmset 不可用)
5. ☑ 所有 `*_HOST` 都是**實際 IP**,沒有任何 localhost/127.0.0.1(容器內的 localhost 是容器自己)

---

## 四、UPS 在 Docker 裡的正確接法(最常踩的坑)

`UPS_SOURCE=auto` 的四個來源中,**pwrstat 與 pmset 在容器內不存在**,只剩兩條路:

**方案 A — NUT(建議,UPS USB 接 NAS 時)**
1. 在跑 Docker 的主機(NAS)上安裝並設定 NUT server,UPS USB 接這台
2. 容器已內建 `upsc` 客戶端(Dockerfile 已裝 `nut`)
3. `.env` 設:`UPS_SOURCE=nut`、`NUT_HOST=<NAS 的區網 IP>`(不能 localhost)、`NUT_UPS_NAME=<ups.conf 裡的名稱>`

**方案 B — PowerPanel Business(UPS USB 接其他電腦時)**
1. 那台電腦跑 CyberPower PowerPanel Business
2. `.env` 設:`PPB_HOST=<那台電腦的 IP>`、`PPB_USER`/`PPB_PASSWORD`

啟動後看 `docker compose logs | grep Diag`,UPS 那行會直接告訴你連上了沒、失敗原因為何。

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
docker run --rm -v unifi-smarthub_smarthub-data:/d -v "$PWD":/b alpine \
  tar czf /b/smarthub-backup.tar.gz -C /d .
```

備份時需包含 `smarthub.db`、`smarthub.db-wal`、`smarthub.db-shm`（上述停止容器後備份的方式會完整包含）。若服務仍在執行，請先停止容器，或使用 SQLite 的 `VACUUM INTO` 產生一致性備份。

---

## 六、驗證部署成功

1. **健康檢查**:`curl http://<主機IP>:3000/health` → `{"status":"healthy",...}`；`curl http://<主機IP>:3000/health/ready` 會再檢查 SQLite/worker；`docker compose ps` 應為 `healthy`
2. **啟動連線診斷**(最快的除錯方式):
   ```bash
   docker compose logs | grep Diag
   ```
   啟動 3 秒後會逐台測試並輸出,例如:
   ```
   ✅ UCG SSH (192.168.0.1:22)：CPU 54°C，正常
   ✅ UniFi 控制器：登入成功
   ❌ UPS：所有來源皆無法讀取 (已嘗試: ppb, nut, ...)
      Docker 環境 UPS 檢查清單：(1) UPS_SOURCE=nut + NUT_HOST=...
   ⚠️ NUT_HOST=localhost：容器內的 localhost 是容器自己，請改成實際 IP
   ```
3. **網頁確認**:「設定 → System Diagnostics」顯示本服務 CPU/RAM/disk/SQLite/worker 與 Active Issues；「目前連線狀態」列出外部設備狀態

---

## 七、疑難排解

| 現象 | 處理 |
| :--- | :--- |
| 啟動就掛 / `.env is a directory` | 忘了先 `cp .env.example .env` 就 `up`,Docker 把 bind mount 建成資料夾了:`docker compose down && rm -rf .env && cp .env.example .env` 重來 |
| 某設備連不上 | 先看 `docker compose logs \| grep Diag`,每台的失敗原因(DNS/逾時/認證/埠拒絕)都有分類提示 |
| 全部設備連不上 | 檢查 `.env` 裡是否有 `localhost`/`127.0.0.1` —— 容器內連不到宿主機或其他設備 |
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
docker compose logs -f                # 追蹤日誌
docker compose logs | grep Diag       # 只看啟動連線診斷
docker compose logs unifi-smarthub | grep 'ERROR\|CRITICAL'
docker compose logs unifi-smarthub | grep 'CODE=DB-'
docker compose logs unifi-smarthub | grep 'TASK=8af32' # 暫時設 LOG_LEVEL=DEBUG 才會看到完整正常 lifecycle
docker compose restart                # 重啟
docker compose up -d --build          # 改程式後重建
docker compose down                   # 停止 (歷史資料保留在 volume)
docker volume ls                      # 確認 smarthub-data 存在
```

---

## 附錄

- `CLAUDE.md` — 完整架構、後端 API 端點對應表、變更紀錄
- `ROADMAP.md` — 未使用 API 盤點與功能路線圖
- `SQLITE-MIGRATION.md` — JSON → SQLite 遷移評估與步驟
- `OBSERVABILITY.md` — Structured Logging、Status Code、Health/Diagnostics API、監控門檻與 Docker 除錯
- `*-api.md` — UniFi / UGREEN / WiiM / CyberPower 各 API 規格參考
