# SmartHub Docker 容器管理設定手冊

這份手冊的目標是讓 SmartHub 的「NAS 儲存 → Docker 容器管理」顯示真實容器，並可查看日誌、啟動、停止及重啟容器。

## 先確認要監控哪一台主機

內建 `nas-monitor` 會讀取「執行 Docker Compose 的同一台主機」上的 `/var/run/docker.sock`：

- SmartHub 部署在 UGREEN NAS：顯示該 NAS 的容器，這是正式部署建議。
- SmartHub 部署在 Mac／Linux 電腦：顯示該電腦的容器，不會跨網路讀取 NAS。

若 SmartHub 與 NAS 不在同一台主機，請在 NAS 上單獨部署本文件後面的「遠端部署」版本。

## 方案 A：SmartHub 與 Docker 容器在同一台主機（建議）

專案的 `docker-compose.yml` 已包含 `nas-monitor`，不需手動安裝 Python 或 Flask。

### 1. 設定 API Key

編輯專案根目錄 `.env`，加入：

```env
NAS_MONITOR_URL=http://nas-monitor:8000
NAS_MONITOR_API_KEY=請改成一串至少32字元的隨機字串
NAS_MONITOR_MODE=docker_only
```

產生隨機 API Key：

```bash
openssl rand -hex 32
```

請把輸出貼到 `NAS_MONITOR_API_KEY=` 後面。不要把真正的 API Key 提交到 Git。

### 2. 重建服務

```bash
docker compose down
docker compose up -d --build
```

### 3. 驗證兩個容器都正常

```bash
docker compose ps
```

應看到：

- `unifi-smarthub`：`healthy`
- `unifi-smarthub-nas-monitor`：`healthy`

接著驗證 SmartHub 代理結果：

```bash
curl http://127.0.0.1:3000/api/nas/docker
```

正常時會回傳：

```json
{
  "containers": [
    {
      "name": "unifi-smarthub",
      "state": "running",
      "cpu_percent": 0.5,
      "mem_usage_mb": 80
    }
  ],
  "source": "nas_monitor"
}
```

最後重新整理 SmartHub 的「NAS 儲存」頁，即可看到容器清單。

## 方案 B：SmartHub 與 NAS 不在同一台主機

在 NAS 上複製本專案的 `nas-monitor/` 目錄，並建立以下 Compose 檔：

```yaml
services:
  nas-monitor:
    build: ./nas-monitor
    container_name: smarthub-nas-monitor
    restart: unless-stopped
    ports:
      - "8000:8000"
    environment:
      - PORT=8000
      - NAS_MONITOR_API_KEY=請改成與SmartHub相同的APIKey
      - DOCKER_SOCKET=/var/run/docker.sock
      - TZ=Asia/Taipei
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

在 NAS 上啟動：

```bash
docker compose up -d --build
```

然後在 SmartHub 的 `.env` 設定：

```env
NAS_MONITOR_URL=http://NAS的區網IP:8000
NAS_MONITOR_API_KEY=與NAS端完全相同的APIKey
NAS_MONITOR_MODE=docker_only
```

重建 SmartHub：

```bash
docker compose up -d --build --force-recreate
```

也可以在網頁的「設定 → 連線設定 → NAS Monitor」填入 URL、API Key，模式選 `docker_only` 後儲存。

## 常見問題

### 仍顯示 0/0

依序執行：

```bash
docker compose ps
docker compose logs --tail=100 nas-monitor
curl http://127.0.0.1:3000/api/nas/docker
```

判讀方式：

- `source: not_configured`：SmartHub 沒讀到 `NAS_MONITOR_URL`。
- HTTP 401：兩邊的 API Key 不一致。
- HTTP 502 或 monitor unhealthy：Docker socket 沒掛載成功或權限不足。
- 回傳容器陣列為空：Monitor 所在的 Docker 主機確實沒有容器。

### 為什麼模式要選 docker_only？

本專案內建的 Monitor 專注於 Docker 容器、資源與日誌。`docker_only` 會讓 NAS CPU、流量、硬碟溫度與儲存歷史繼續使用 SmartHub 既有的 UGOS 真實取樣器，避免被空資料覆蓋。

只有部署了支援 `/api/system/history`、`/api/temperature/history`、`/api/alerts` 與 SSE 的完整外部 NAS Monitor 時，才選 `full`。

## 安全提醒

掛載 `/var/run/docker.sock` 等同授予管理該 Docker 主機的高權限：

- 只在可信任的內網使用。
- 不要把 Monitor 的 8000 port 直接暴露到公網。
- API Key 至少使用 32 個隨機字元。
- SmartHub 面板請設定 `PANEL_PASSWORD`，遠端存取建議走 VPN。
