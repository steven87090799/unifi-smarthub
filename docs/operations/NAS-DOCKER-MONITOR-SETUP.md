# SmartHub Docker 容器管理指南

`nas-monitor` 是高權限選配服務，提供容器清單、資源、日誌與受限啟停操作。預設 Compose 不啟用，且 SmartHub readiness 不依賴它。

## 信任邊界

可寫 Docker socket 等同宿主機 root 權限。非 root、read-only rootfs、cap drop、`no-new-privileges` 與資源限制只能縮小一般攻擊面，不能消除 socket 權限。

- 只在可信任內網主機啟用。
- 不需要 Docker 管理時不要掛載 socket。
- 使用獨立、至少 32 bytes 的 `NAS_MONITOR_API_KEY`。
- 面板仍必須設定 `PANEL_PASSWORD`。
- mutation 與 log 使用不同 allowlist；SmartHub 與 monitor 自身永久 protected。

## 同一台 Docker 主機

1. 產生金鑰：

```bash
openssl rand -hex 32
```

2. 寫入 `config/.env`：

```env
NAS_MONITOR_URL=http://nas-monitor:8000
NAS_MONITOR_API_KEY=<隨機值>
NAS_MONITOR_MODE=docker_only
```

3. 只為允許操作的容器加入 label：

```yaml
labels:
  - com.unifi.smarthub.nas-monitor.managed=true
  - com.unifi.smarthub.nas-monitor.logs=true
```

再明確啟用：

```env
NAS_MONITOR_MUTATIONS_ENABLED=true
NAS_MONITOR_ACTION_ALLOW_LABELS=com.unifi.smarthub.nas-monitor.managed=true
NAS_MONITOR_LOGS_ENABLED=true
NAS_MONITOR_LOG_ALLOW_LABELS=com.unifi.smarthub.nas-monitor.logs=true
```

不要使用過寬 label。完整 64 字元 container ID 也可列入 allowlist，但重建後會失效。

4. Linux 查詢 socket GID：

```bash
stat -c '%g' /var/run/docker.sock
```

```env
DOCKER_SOCKET_GID=<輸出的數字>
```

Docker Desktop／OrbStack 常見值為 `0`。權限不足時修正 GID，不要把 monitor 改成 root。

5. 驗證並啟動：

```bash
docker compose --env-file config/.env config --quiet
docker compose --env-file config/.env --profile nas-monitor up -d --build
docker compose --env-file config/.env ps
```

正式發布應先建立不可變成對映像，再改用 `--no-build --pull never`；見 [正式發布檢查清單](PRODUCTION-RELEASE-CHECKLIST.md)。

API 快速確認：

```bash
curl --user admin http://127.0.0.1:3000/api/nas/docker
```

停用：

```bash
docker compose --env-file config/.env --profile nas-monitor stop nas-monitor
docker compose --env-file config/.env --profile nas-monitor rm -f nas-monitor
```

並移除 monitor URL、key、profile 與相關 allowlist。

## 遠端 Docker 主機

- 優先使用 WireGuard／Tailscale 等 VPN，或由受信任 Caddy／nginx 終止 TLS。
- 不要把原生 HTTP port `8000` 直接暴露公網。
- NAS 端部署 `nas-monitor/`，設定相同 API key、socket GID 與 allowlist。
- SmartHub 端設定固定 HTTPS origin：

```env
NAS_MONITOR_URL=https://monitor.internal.example
NAS_MONITOR_API_KEY=<與遠端相同>
NAS_MONITOR_MODE=docker_only
```

私有 CA 放入 `config/`，並設：

```env
NAS_MONITOR_CA_FILE=/app/config/monitor-ca.pem
```

只有 VPN 與 firewall 已保護、且無法使用 TLS 時，才明確設 `NAS_MONITOR_ALLOW_INSECURE_HTTP=true`。不要以 `NAS_MONITOR_TLS_INSECURE=true` 當一般解法。遠端模式不啟用 SmartHub Compose 內的 profile。

## 模式

- `docker_only`：內建 monitor，只提供 Docker；NAS 遙測與歷史仍由 UGOS 取樣。
- `full`：僅供支援完整 history、alerts、SSE 契約的外部 monitor。

## 常見問題

```bash
docker compose --env-file config/.env --profile nas-monitor ps
docker compose --env-file config/.env --profile nas-monitor logs --tail=100 nas-monitor
```

| 現象 | 處理 |
|---|---|
| `source: not_configured` | 檢查 `NAS_MONITOR_URL` 與 recreate-required 狀態 |
| HTTP 401 | 兩端 API key 缺少或不一致 |
| HTTP 502／unhealthy | socket 未掛載、GID 錯誤或 Docker daemon 不可用 |
| 只有 SmartHub service | 尚未加 `--profile nas-monitor`，屬安全預設 |
| 可看但不能操作 | mutation 預設關閉，或目標不符合 allowlist |
| readonly 看不到 logs | 正常；logs 僅限 admin 且需獨立 allowlist |
