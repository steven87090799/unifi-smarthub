# SmartHub Docker 容器管理設定手冊

內建 `nas-monitor` 可讓 SmartHub 的「NAS 儲存 → Docker 容器管理」顯示真實容器，並可查看日誌、啟動、停止及重啟容器。這是高權限選配功能：預設 `docker compose up` 不會啟動 monitor，SmartHub 也不會依賴 monitor 才能啟動。

## 必須先知道的信任邊界

可寫的 `/var/run/docker.sock` 可建立特權容器、掛載宿主機根目錄，實質上等同該 Docker 主機的 root 控制權。本專案已將 monitor 設為非 root、read-only root filesystem、移除 Linux capabilities、`no-new-privileges`、PID/記憶體限制、受限 `/tmp`、tini PID 1 與內部專用網路，但這些措施只會縮小一般容器攻擊面，**不會消除 Docker socket 的宿主機 root 權限**。

因此：

- 只在可信任、專用的內網 Docker 主機啟用。
- 不需要容器啟停功能時，不要啟用 profile，也不要掛載 socket。
- `NAS_MONITOR_API_KEY` 使用獨立、至少 32 字元的隨機值，不可與其他服務共用。
- 務必設定 SmartHub `PANEL_PASSWORD`；API key 只是 monitor 的 service-to-service 認證，不是面板認證的替代品。

## 先確認要控制哪一台主機

內建 monitor 讀取「執行 Docker Compose 的同一台主機」的 Docker socket：

- SmartHub 部署在 UGREEN NAS：顯示該 NAS 的容器。
- SmartHub 部署在 Mac/Linux 電腦：顯示該電腦的容器，不會跨網路讀取 NAS。

SmartHub 與 NAS 不在同一台主機時，請使用下方「遠端部署」，並用 VPN 或受信任 TLS 保護傳輸。

## 方案 A：SmartHub 與目標 Docker 主機相同

### 1. 產生專用 API key

```bash
openssl rand -hex 32
```

編輯唯一部署設定來源 `config/.env`，寫入產生的值：

```env
NAS_MONITOR_URL=http://nas-monitor:8000
NAS_MONITOR_API_KEY=請貼上剛才產生的隨機值
NAS_MONITOR_MODE=docker_only
```

Compose 沒有預設 monitor URL 或可用金鑰；少了任一項時，monitor 不應視為可用。

monitor 預設只提供 inventory、metrics 與 logs，所有 start/stop/restart 都 fail closed。若確實要啟用控制，必須先只替可管理的目標容器加 opt-in label：

```yaml
labels:
  - com.unifi.smarthub.nas-monitor.managed=true
```

再於 `config/.env` 設定：

```env
NAS_MONITOR_MUTATIONS_ENABLED=true
NAS_MONITOR_ACTION_ALLOW_LABELS=com.unifi.smarthub.nas-monitor.managed=true
```

容器 log 常含 reset link、token 或其他敏感資訊，因此也預設關閉，且不沿用 mutation allowlist。只替明確允許讀 log 的容器加 `com.unifi.smarthub.nas-monitor.logs=true`，再設定：

```env
NAS_MONITOR_LOGS_ENABLED=true
NAS_MONITOR_LOG_ALLOW_LABELS=com.unifi.smarthub.nas-monitor.logs=true
```

即使在 allowlist 中，SmartHub 與 broker 的 protected container 仍會拒絕 log；面板端也只有 admin 可讀，readonly 帳號會收到 403。

SmartHub 與 monitor 自身已有 protected label，即使 allowlist 設定錯誤也不能被 broker 操作。也可用 `NAS_MONITOR_ACTION_ALLOW_IDS` 列出完整 64 字元 container ID，但 container 重建後 ID 會改變，長期設定建議用精確 label。不要用 project-wide 或可被不可信 workload 自行加入的寬鬆 label。

### 2. 設定 Docker socket group

monitor 以 image 內的 `node` 非 root 使用者執行，Compose 只追加 socket 的 numeric GID。Linux 主機可查詢：

```bash
stat -c '%g' /var/run/docker.sock
```

將結果填入 `config/.env`：

```env
DOCKER_SOCKET_GID=上一個指令輸出的數字
```

Docker Desktop/OrbStack 的 socket 通常映射為 GID `0`，Compose 也以 `0` 為相容預設。若 healthcheck 回報 socket 權限不足，請以實際 socket GID 為準，不要將 monitor 改成 root。非預設 socket 路徑可另設 `DOCKER_SOCKET_PATH`。

### 3. 驗證設定並明確啟用 profile

```bash
docker compose --env-file config/.env config --quiet
docker compose --env-file config/.env --profile nas-monitor up -d --build
docker compose --env-file config/.env ps
```

也可在 `config/.env` 設 `COMPOSE_PROFILES=nas-monitor`，但明確寫在啟動指令中更容易審核。`docker compose --env-file config/.env ps` 應顯示 `unifi-smarthub` 與 `nas-monitor` 兩個 service 都是 `healthy`。SmartHub 的容器健康以 `/health/ready` 為準，會同時檢查 SQLite 與 worker。

到 SmartHub「NAS 儲存」頁驗證容器清單。若要用 API 驗證，下列指令會互動詢問面板密碼，不會把密碼寫進 shell history：

```bash
curl --user admin http://127.0.0.1:3000/api/nas/docker
```

要停用高權限 monitor：

```bash
docker compose --env-file config/.env --profile nas-monitor stop nas-monitor
docker compose --env-file config/.env --profile nas-monitor rm -f nas-monitor
```

並移除 `config/.env` 中的 monitor URL/key 與 profile 設定。

## 方案 B：SmartHub 與 NAS 不在同一台主機

在 NAS 上複製本專案的 `nas-monitor/` 目錄。建議優先建立 WireGuard/Tailscale 等 VPN，只將 monitor bind 到 VPN interface；或只 bind 到 `127.0.0.1`，由同機受信任的 Caddy/nginx 終止 TLS。monitor 原生是 HTTP，API key 不會加密傳輸，**不要將 port 8000 直接暴露於公網**。

遠端 Compose 可使用下列基線：

```yaml
services:
  nas-monitor:
    build: ./nas-monitor
    restart: unless-stopped
    stop_grace_period: 20s
    user: "1000:1000"
    ports:
      # 預設只供同機 TLS 反向代理；VPN 模式改為該主機的 VPN IP。
      - "${NAS_MONITOR_BIND_IP:-127.0.0.1}:${NAS_MONITOR_HOST_PORT:-8000}:8000"
    environment:
      PORT: "8000"
      NAS_MONITOR_API_KEY: ${NAS_MONITOR_API_KEY:?set a unique random key}
      NAS_MONITOR_MUTATIONS_ENABLED: ${NAS_MONITOR_MUTATIONS_ENABLED:-false}
      NAS_MONITOR_ACTION_ALLOW_IDS: ${NAS_MONITOR_ACTION_ALLOW_IDS:-}
      NAS_MONITOR_ACTION_ALLOW_LABELS: ${NAS_MONITOR_ACTION_ALLOW_LABELS:-}
      NAS_MONITOR_LOGS_ENABLED: ${NAS_MONITOR_LOGS_ENABLED:-false}
      NAS_MONITOR_LOG_ALLOW_IDS: ${NAS_MONITOR_LOG_ALLOW_IDS:-}
      NAS_MONITOR_LOG_ALLOW_LABELS: ${NAS_MONITOR_LOG_ALLOW_LABELS:-}
      DOCKER_SOCKET: /var/run/docker.sock
      TZ: ${TZ:-Asia/Taipei}
    group_add:
      - "${DOCKER_SOCKET_GID:?set the Docker socket numeric GID}"
    volumes:
      - type: bind
        source: ${DOCKER_SOCKET_PATH:-/var/run/docker.sock}
        target: /var/run/docker.sock
    read_only: true
    cap_drop: ["ALL"]
    security_opt: ["no-new-privileges:true"]
    pids_limit: 64
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=16m
    mem_limit: 96m
    mem_reservation: 32m
```

產生並設定遠端 `NAS_MONITOR_API_KEY`、`DOCKER_SOCKET_GID` 後，先執行 `docker compose config --quiet`，再啟動。VPN HTTP 模式應搭配宿主機 firewall，只允許 SmartHub 的 VPN IP；HTTPS 模式應使用 SmartHub 主機信任的 CA/憑證，不要關閉憑證驗證。

然後在 SmartHub 的 `config/.env` 設定 HTTPS URL：

```env
NAS_MONITOR_URL=https://monitor.internal.example
NAS_MONITOR_API_KEY=與NAS端完全相同的隨機值
NAS_MONITOR_MODE=docker_only
```

私有 CA 時，將 CA 檔放在專用 `config/` 目錄，並設 `NAS_MONITOR_CA_FILE=/app/config/<ca-file>`。若只能使用已由 VPN 與 firewall 保護的明文 HTTP，必須另加 `NAS_MONITOR_ALLOW_INSECURE_HTTP=true`；這只是明確接受 transport 風險，不會加密 API key。不要同時設定 `NAS_MONITOR_TLS_INSECURE=true` 來繞過憑證驗證。

遠端模式不需要啟用 SmartHub Compose 內的 `nas-monitor` profile。

## 常見問題

### 仍顯示 0/0

```bash
docker compose --env-file config/.env --profile nas-monitor ps
docker compose --env-file config/.env --profile nas-monitor logs --tail=100 nas-monitor
```

判讀方式：

- `source: not_configured`：SmartHub 沒讀到 `NAS_MONITOR_URL`。
- HTTP 401：API key 未設定或兩邊不一致；Compose 不再提供共用預設金鑰。
- HTTP 502 或 monitor unhealthy：Docker socket 沒掛載成功、GID 不匹配，或 Docker daemon 不可用。
- 容器陣列為空：Monitor 所在的 Docker 主機確實沒有容器。
- 只有 SmartHub service：尚未加 `--profile nas-monitor`，這是安全預設。

### 為什麼模式要選 docker_only？

內建 Monitor 專注於 Docker 容器、資源與日誌。`docker_only` 會讓 NAS CPU、流量、硬碟溫度與儲存歷史繼續使用 SmartHub 既有的 UGOS 真實取樣器，避免被空資料覆蓋。

只有部署了支援 `/api/system/history`、`/api/temperature/history`、`/api/alerts` 與 SSE 的完整外部 NAS Monitor 時，才選 `full`。
