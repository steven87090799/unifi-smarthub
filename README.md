# SmartHub — UniFi × UGREEN NAS 整合戰情室

自架的網路與儲存監控面板，把 **UniFi UCG-Ultra**（硬體/客戶端/WiFi/IPS 威脅/雲端）與 **綠聯 UGREEN UGOS Pro NAS**（CPU/記憶體/硬碟/儲存區/UPS）整合到單一網頁，採前後端分離架構，所有金鑰與帳密僅保存在後端。

- **前端**：`public/index.html`（側邊欄 + 7 分頁 SPA：總覽 / 客戶端 / 資安 / WiFi / 雲端站點 / NAS / 工具）
- **後端**：`server.js`（Express，預設 port 3000），資料來源為 SSH、UniFi 本地 API、UniFi 雲端 Site Manager API、UGREEN UGOS API
- **開發用假資料後端**：`server-mock.js`（port 3005，免任何設定即可預覽介面）

---

## 一、部署前你需要準備的資料

以下依「想啟用的功能」分組。**全部都是選填的** —— 沒填的區塊會自動顯示展示用假資料，面板仍可正常開啟。建議至少填第 1、2 組，才能看到真實網路數據。

| 分組 | 變數 | 說明 / 從哪裡拿 |
| :--- | :--- | :--- |
| **1. UCG 硬體監控 (SSH)** | `UCG_IP` | UCG-Ultra 的區網 IP |
| | `SSH_USER` / `SSH_PASSWORD` | UCG 的 SSH 帳密。在 UniFi 主控台 → 設定 → 系統 → **SSH** 開啟並設定 |
| | `SSH_PORT` | 預設 22 |
| | `WAN_IFACE` | WAN 對應的網卡名稱，UCG-Ultra 通常是 `eth4`（不確定可先用預設，看硬體頁哪個埠是 WAN 再調） |
| **2. UniFi 本地控制** | `UNIFI_CONTROLLER_URL` | 控制器網址，UniFi OS 裝置通常是 `https://<UCG_IP>` |
| | `UNIFI_USERNAME` / `UNIFI_PASSWORD` | 一組**本地**管理員帳號（建議在主控台另開一個唯讀/受限的本地帳號，不要用你的 Ubiquiti SSO 主帳號） |
| **3. UniFi 雲端 (選填)** | `UNIFI_API_KEY` | 在 [unifi.ui.com](https://unifi.ui.com) → Site Manager → API 建立。用於多站點 / SD-WAN / ISP 指標。不填就用假資料 |
| **4. UGREEN NAS (選填)** | `NAS_HOST` | NAS 的區網 IP。啟用 CPU/記憶體/硬碟/儲存區/UPS 即時監控 |
| | `NAS_USER` / `NAS_PASSWORD` | UGOS 管理員帳密。**密碼不可包含 `#` `*` `§`**（UGOS API 限制） |
| | `NAS_PORT` / `NAS_SCHEME` | 預設 `9443` / `https` |
| **5. NAS Monitor 中介層 (選填)** | `NAS_MONITOR_URL` | 另外部署的 [nas-monitor-interface](https://github.com/) Flask 服務網址。啟用 Docker 容器管理、流量/儲存/溫度歷史圖、儲存滿載預測、系統警報等進階功能 |
| | `NAS_MONITOR_API_KEY` | 該中介層的 API 授權金鑰 |

> **安全建議**：這個面板具有斷網、關 WiFi、PoE 斷電等控制權限，請只在內網或有防護的環境部署，不要直接曝露到公網。若要遠端存取，建議放在 VPN 或反向代理 + 驗證之後。

---

## 二、Docker 部署步驟（建議）

### 前置需求
- 一台在你內網、能連到 UCG 與 NAS 的主機（Linux / NAS / 小主機皆可）
- 已安裝 Docker 與 Docker Compose

### 步驟

```bash
# 1. 進入專案目錄
cd unifi-smarthub

# 2. 從範本建立你的 .env 並填入上表的資料
cp .env.example .env
nano .env          # 或用任何編輯器填寫

# 3. 建置並啟動 (背景執行)
docker compose up -d --build

# 4. 查看啟動狀態與日誌
docker compose ps
docker compose logs -f
```

啟動後開瀏覽器進入 `http://<主機IP>:3000`。

### 常用維運指令

```bash
docker compose logs -f                 # 追蹤日誌
docker compose restart                 # 重啟
docker compose down                    # 停止並移除容器 (歷史資料保留在 volume)
docker compose up -d --build           # 改了程式碼後重新建置
docker compose pull && docker compose up -d   # (若改用 registry image)
```

### 改連接埠
預設對外是 3000。要改成例如 8080，編輯 `docker-compose.yml` 的 `ports`：
```yaml
    ports:
      - "8080:3000"
```

---

## 三、記憶體限制

已在 `docker-compose.yml` 設定，無需額外處理：

```yaml
    mem_limit: 256m          # 上限 256MB
    mem_reservation: 128m    # 保留 128MB
```

這是輕量 Node 服務（Express + 定時輪詢 + 一條 SSH），實測常駐約 60–120MB，256MB 上限很充裕。若你的主機記憶體很緊，可降到 `192m`；若之後歷史資料量放大或加了重的功能，再往上調即可。容器內也用 `tini` 當 PID 1，能正確回收 SSH 子連線，不會累積殭屍程序。

---

## 四、歷史數據與資料庫

**目前沒有使用資料庫，改用輕量 JSON 檔持久化**，這對本專案的規模（單一家庭/小辦公室、每 5 分鐘取樣、上限約 2000 筆）完全足夠，也不必額外跑一個 DB 容器。

存放在容器內 `/app/data`，共三個檔：

| 檔案 | 內容 | 上限 |
| :--- | :--- | :--- |
| `trend-history.json` | 歷史趨勢（客戶端數 / 24H 威脅數 / ISP 延遲），自適應頻率取樣 | 9999 筆 |
| `block-history.json` | 存取控制封鎖 / 解封時間軸 | 最近 200 筆 |
| `security-settings.json` | 資安設定（自動防禦開關） | — |
| `notification-settings.json` | 通知推播設定（管道、Webhook、觸發條件） | — |
| `app-settings.json` | 伺服器端取樣間隔與定期報表設定 | — |

**關鍵：這個目錄已透過 Docker 具名 volume `smarthub-data` 持久化**，所以 `docker compose down` / 重建映像 / 更新版本都**不會遺失**歷史資料。

> **趨勢取樣頻率是自適應的**：有人開著網頁時每 5 秒取樣一次（前端每 5 秒送心跳；切到背景分頁會暫停），沒人瀏覽時自動降為每 30 分鐘一次。這樣既能在你查看時有高解析度的即時曲線，又不會在無人使用時持續打 UniFi API。

```bash
docker volume ls                       # 應能看到 <專案>_smarthub-data
docker run --rm -v smarthub_smarthub-data:/d alpine ls -l /d   # 檢視 volume 內容
```

備份歷史資料：
```bash
docker run --rm -v smarthub_smarthub-data:/d -v "$PWD":/b alpine \
  tar czf /b/smarthub-data-backup.tar.gz -C /d .
```

> **要不要升級成真正的資料庫？** 若之後想保留數月以上的細粒度歷史、做跨月報表、或多實例共用資料，建議改用 **SQLite**（單檔、免額外容器，一樣掛在這個 volume 即可）。目前的用途用 JSON 就好，不需要為此增加複雜度。需要時再告訴我，我可以把三個 JSON 換成 SQLite。

---

## 五、驗證部署是否成功

1. **健康檢查**：`curl http://<主機IP>:3000/healthz` 應回 `{"status":"ok",...}`。Docker 也會自動用它做 healthcheck，`docker compose ps` 的 STATUS 欄會顯示 `healthy`。
2. **總覽頁**：WAN 狀態、線上設備數、CPU 溫度應是真實數字（若顯示假資料，代表對應的 `.env` 沒填或連線失敗）。
3. **資料來源標記**：雲端頁與 NAS 頁右上角的徽章 —— `ONLINE` 表示連到真實 API，`DEMO` 表示正在用假資料回退。

---

## 六、疑難排解

| 現象 | 可能原因與處理 |
| :--- | :--- |
| 硬體頁一直是舊/空資料 | SSH 連不上：檢查 `UCG_IP`/`SSH_*`，並確認 UCG 已開啟 SSH。看 `docker compose logs` 是否有 `SSH Connection Failed` |
| 客戶端 / WiFi / 威脅是空的 | 本地 API 登入失敗：檢查 `UNIFI_CONTROLLER_URL` 與帳密。UniFi OS 裝置網址用 `https://<ip>` |
| 雲端頁顯示 `DEMO` | `UNIFI_API_KEY` 未填或仍是佔位字串，屬正常回退 |
| NAS 頁某欄位顯示 `--` | UGOS 回應欄位名與預期不同。打開 NAS 頁底部「原始遙測資料 (Raw JSON)」對照實際鍵名回報，即可補上對應 |
| NAS 完全連不上 | 確認 `NAS_HOST`/帳密，且密碼不含 `#` `*` `§` |
| build 時出現 `cpu-features` 編譯警告 | 可忽略：它是 ssh2 的選用原生加速模組，缺編譯器時會自動跳過，ssh2 改走純 JS 模式仍正常運作 |
| 自簽憑證錯誤 | 後端已對 UCG 與 NAS 忽略自簽憑證驗證（`rejectUnauthorized: false`），僅限內網使用 |

---

## 七、本機開發（不用 Docker）

```bash
npm install
cp .env.example .env      # 填資料；或不填直接看假資料
npm start                 # 正式後端，需要 .env 才有真實數據
# 或
node server-mock.js       # 純假資料，開 http://localhost:3005 預覽介面
```

---

## 附錄：API 規格參考

- `../unifi-network-api.md` — UniFi Network / Site Manager API 規格
- `../ugreen-nas-api.md` — UGREEN UGOS Pro NAS API 規格
- `CLAUDE.md` — 本專案完整架構、後端端點對應表與變更記錄
