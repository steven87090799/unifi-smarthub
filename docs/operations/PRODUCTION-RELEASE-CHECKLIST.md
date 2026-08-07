# SmartHub 正式發布檢查清單

所有命令從 repository root 執行。`config/.env` 只存在部署主機，不可提交或輸出展開後的 Compose config。

## 1. 前置條件

- 預定發布 commit 的 `git status --short` 無輸出。
- SmartHub container 預設以 UID/GID `1000:1000` 執行；`config/` 權限 `0700`、`config/.env` 權限 `0600`，且該 UID 可在目錄內建立、fsync、rename。
- Preflight 會要求 `config/.env` 及 SQLite `smarthub.db` 可讀寫；既有 `-wal`／`-shm` 也必須是可讀寫 regular file，並以 `PRAGMA quick_check=ok` 驗證。`--offline` 才會額外執行 `BEGIN IMMEDIATE; ROLLBACK;` writer probe。
- 新的 `smarthub-data` volume 必須先以同一個已建立 image 執行一次 `createHistoryDb` 初始化 schema；preflight 不會自動略過或建立遺失的資料庫，既有 volume 不可重建覆蓋。
- 根目錄沒有第二份 `.env`；所有 Compose 指令使用同一個 `--env-file config/.env`。
- 已設定 `PANEL_PASSWORD`；唯讀密碼不得等於管理員密碼。
- 容器內 upstream 位址不是 `localhost`／`127.0.0.1`。
- Docker UPS 使用 `UPS_SOURCE=ppb`、`host.docker.internal:3052`，或容器可達的 NUT server。
- `UPS_SOURCE` 明確指定時預設 fail-closed；只有明確設定 `UPS_ALLOW_FALLBACK=true` 才可回退到其他來源。
- Compose host-side port 預設只發布到 `127.0.0.1`（`SMARTHUB_HOST_BIND_ADDRESS`）；容器內 `SMARTHUB_BIND_ADDRESS=0.0.0.0` 只服務 container network。
- `TRUSTED_LAN_MODE` 是 compatibility master switch；安全 baseline 應保持 `TLS_VERIFY=true`、`TLS_INSECURE=false`、`ALLOW_INSECURE_HTTP=false` 與 SSH unpinned=false。開啟時只有經 private/allowlist classification 的 Controller、NAS、PPB、AdGuard、WiiM 與 SSH target 產生 scoped compatibility transport；關閉後不會自動接受 self-signed TLS、HTTP 或 unpinned SSH。configured CA／SSH fingerprint 永遠優先；明確 legacy/manual insecure override 必須顯示為 explicit mode。公網 integration 仍必須 verified TLS；公開部署請關閉此模式。
- 已完成安全備份；需要完整離線備份時先停止服務並保存 DB／WAL／SHM。
- `config/.env` 已由 NAS 的加密備份機制另行保護，備份目的地位於不同 storage mount；同一 Docker volume 不等於 disaster recovery。
- 正式 Web 入口是 Caddy／Nginx 等 HTTPS reverse proxy；`http://<NAS IP>:3000` 只可作為隔離的 local probe，不是 production 使用路徑。
- `PANEL_REQUIRE_HTTPS=true`、`PANEL_ALLOW_INSECURE_HTTP=false`，並只對實際 reverse proxy 設定 `PANEL_TRUSTED_PROXIES`。
- `SMARTHUB_INTERNET_PROXY_MODE=disabled`；只有明確選擇 `environment` 才讓 public integrations 使用 ambient `HTTP_PROXY`／`HTTPS_PROXY`／`ALL_PROXY`，LAN integrations 永遠 `proxy:false`。
- UniFi／NAS HTTPS 預設驗證憑證；私有 CA 使用 `*_CA_FILE`，insecure 只能由明確 opt-in 開啟。
- 未使用 Trusted LAN mode 時，已設定所有啟用 SSH integration 的 host fingerprint；使用 Trusted LAN mode 時，未 pin 只可對分類為私有的 UCG／Linux／UniFi Device SSH target 放行，Controller-known device、MAC allowlist、literal IP、固定唯讀指令與 concurrency 邊界仍必須保留。
- AdGuard connectivity 與 protection 必須是不同狀態；離線需連續 3 次明確 failure，恢復需連續 2 次 fresh success。Site Manager 使用相同 threshold，unknown/stale 不得產生通知。
- 只有需要 Docker 管理時才啟用 `nas-monitor` profile。
- `.github/dependabot.yml` 只管理版本更新排程、分組與自動 PR 上限；Dependabot Alerts／security updates 仍由 GitHub repository 的 `Settings → Code security and analysis` 設定管理，不能由此檔案宣稱已啟用。

## 2. 程式庫檢查

正式 release 執行完整 gate；部署相關命令必須保持 Build → Preflight → Start：

```bash
npm ci
npm test
npm run check:js
npm run check:css
npm run test:smoke
npm audit --audit-level=low
git diff --check
docker compose --env-file config/.env config --quiet
docker compose --env-file config/.env --profile nas-monitor config --quiet
docker compose --env-file config/.env build unifi-smarthub
docker compose --env-file config/.env --profile nas-monitor build
# 僅第一次使用全新的 smarthub-data volume 時執行一次；既有資料庫跳過且不可覆蓋。
docker compose --env-file config/.env run --rm --no-deps \
  unifi-smarthub node -e "const { createHistoryDb } = require('./db'); const db = createHistoryDb(process.env.DATA_DIR); db.close();"
docker compose --env-file config/.env run --rm --no-deps \
  unifi-smarthub node scripts/production-preflight.js --offline
docker compose --env-file config/.env up -d --no-build
```

若只需快速定位安全／Docker／restart／release 契約：

```bash
node --test \
  test/panel-security.test.js \
  test/write-input-policy.test.js \
  test/write-route-contract.test.js \
  test/docker-action-policy.test.js \
  test/nas-monitor-client.test.js \
  test/nas-monitor.test.js \
  test/config-restart.test.js \
  test/frontend-connection-restart.test.js \
  test/deployment-contract.test.js \
  test/release-build.test.js
```

任何失敗先保存第一個證據並找 root cause，不要只重跑到綠燈。Low／Moderate／High／Critical 任一 audit finding 都不得放行。

本次 Trusted LAN／notification 修正只做完整 unit/integration tests、Compose config/build、offline preflight、smoke 與 90 秒至數分鐘的短 runtime stability check；不執行數小時 `npm run test:soak`。短驗證不等同真實設備、PPB、AdGuard、WiiM、SSH 或通知服務的實機驗收。

Pull Request 的 GitHub Actions workflow 為 `SmartHub CI`，check 名稱為 `Repository gate`。Hosted gate 在 locked install、測試、CSS、low-level audit、Compose 與雙映像 build 後，執行隔離 `npm run test:smoke`；它只使用臨時 DATA_DIR／ENV_FILE／port、loopback 假整合與假帳密，不掛 Docker socket，也不代表正式 NAS 或真實設備已驗證。`main` 的 branch protection／ruleset 應將 `SmartHub CI / Repository gate` 設為 Required Check，要求分支為最新並禁止 CI 未通過時 merge。Workflow 檔存在不代表 repository 規則已啟用；沒有管理權限驗證時記為 `NOT RUN`。

### HTTPS reverse proxy 範例

正式對外只發布 proxy 的 HTTPS port，SmartHub 直接綁定的 `3000` 保持在 loopback 或受限的 container network。兩種拓撲必須分開設定 trusted proxy。

#### Host-native Caddy/Nginx

Host 上的 proxy 導向 SmartHub 的 host port。Caddy：

```caddyfile
smarthub.example.internal {
    reverse_proxy 127.0.0.1:3000
}
```

若 proxy 與 SmartHub 都在 host，`PANEL_TRUSTED_PROXIES` 可使用實際 loopback（例如 `loopback`）；Nginx 至少要傳遞可信 protocol header：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

#### Dockerized Caddy/Nginx

Proxy container 與 `unifi-smarthub` 必須接在同一個 Docker network，導向 service DNS，而不是 proxy container 自己的 loopback：

```caddyfile
smarthub.example.internal {
    reverse_proxy unifi-smarthub:3000
}
```

在這種拓撲，`PANEL_TRUSTED_PROXIES` 必須填 proxy container 的實際 IP／受控 CIDR（例如由固定 network/容器部署檢查得到的 `172.30.0.2/32`），不可填 `127.0.0.1` 來代表另一個 container，也不可使用 `true`、`*` 或 hop count。Caddy／Nginx 必須傳遞正確的 `Host` 與 `X-Forwarded-Proto=https`。

不可信來源的 `X-Forwarded-Proto: https` 不得繞過 HTTPS policy。production 啟用 HTTPS enforcement 但缺少 trusted proxy 時，SmartHub 只記錄診斷 warning，不會自動 trust all；若是 TLS termination，應先修正 proxy IP/CIDR 再放行。

### Docker socket accepted risk

`nas-monitor` profile 預設停用。取得 Docker socket 的 process 若發生 RCE，可能取得宿主機高權限；非 root、read-only rootfs、cap drop、`no-new-privileges` 與資源限制只能縮小一般攻擊面，不能消除這項風險。Docker socket 的 `:ro` bind mount 也不是 Docker Engine API 的 read-only security boundary；若要啟用，必須使用專用 host、強 API key、mutation／allowlist 預設關閉並接受此風險。

## 3. 建立不可變成對映像

```bash
npm run release:build
```

此命令會拒絕 staged、unstaged、untracked 差異，從 `git archive HEAD` 建置兩個 staging image，驗證 version／revision／created／dirty identity，再成對發布 revision tags。

保存輸出 JSON 的 `revision`、`images`、`image_ids`，並寫入部署主機：

```dotenv
SMARTHUB_IMAGE=unifi-smarthub:<12-char-revision>
NAS_MONITOR_IMAGE=unifi-smarthub-nas-monitor:<12-char-revision>
```

本機 tag／image ID 不等於 registry digest。若使用 registry，必須成對 push、記錄兩個 immutable digest，並以 digest 或不可變 tag 部署。

## 4. 隔離演練與啟動

Preflight 必須針對已建立的同一組 release image 執行；通過後才可啟動：

```bash
# 僅全新的 smarthub-data volume 執行一次；既有資料庫跳過且不可覆蓋。
docker compose --env-file config/.env run --rm --no-deps \
  unifi-smarthub node -e "const { createHistoryDb } = require('./db'); const db = createHistoryDb(process.env.DATA_DIR); db.close();"
docker compose --env-file config/.env run --rm --no-deps \
  unifi-smarthub node scripts/production-preflight.js --offline
```

```bash
docker compose --env-file config/.env -p smarthub-prod up -d --no-build --pull never

# 需要 monitor 時
docker compose --env-file config/.env -p smarthub-prod --profile nas-monitor \
  up -d --no-build --pull never
```

```bash
docker compose --env-file config/.env -p smarthub-prod ps
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/health/ready
curl --user admin http://127.0.0.1:3000/api/system/status
```

至少確認：

- 執行中的 image ID 與 release JSON 完全一致；普通開發 image 的 identity 不可放行。
- 匿名被拒絕、readonly 只讀、admin 異動仍需 Origin／CSRF。
- Docker logs 與 mutation 使用不同 allowlist，且不能操作 protected container。
- monitor 未啟用或故障時，不把主服務誤判為未 ready。
- 一般設定 restart 後仍存在；`NAS_MONITOR_*` recreate-scoped 設定協調重建後清除 pending state。
- restart／force-recreate 後 SQLite `quick_check`、排程 ownership 與設定 authority 正常。
- SIGTERM 在 20 秒 grace period 內安全停止，重啟後 readiness 回復。
- diagnostics 與 logs 不洩漏 credential。
- `/health/operational` 只作 authenticated operational view；`/health`、`/healthz`、`/health/ready` 維持 process/container probe，不因外部整合離線而觸發無限 restart。

真正的 UniFi、NAS、WiiM、AdGuard、UPS、PoE 或非隔離 Docker mutation 需另行明確授權。

## 5. 回滾

1. 同時把 SmartHub／NAS Monitor 改回上一組已驗證 identity。
2. 使用相同 project、config dir、env file 與 profile 執行 `up -d --no-build --pull never`。
3. 重跑 health、角色、SQLite、重要整合與 restart 檢查。
4. 若有 staged restore，先確認交易狀態再替換 volume。

不要重指已發布 tag，也不要以 `docker compose down -v` 回滾；`-v` 會刪除持久資料。

## 6. 發布紀錄

記錄 Git commit、兩個映像 tag／digest／ID、Compose project、設定 authority、profile、測試／audit、演練時間、health／restart／SIGTERM／SQLite 結果、故障注入、未執行項目、回滾 identity 與操作者。

短時間加速測試只能證明實際執行的 cycles，不可宣稱等同長期 soak。

完整的 Gate A-E 驗收矩陣與本次分支證據見 [PRODUCTION_ACCEPTANCE.md](PRODUCTION_ACCEPTANCE.md) 與 [PRODUCTION_LONG_RUN_HARDENING_REPORT.md](../reports/PRODUCTION_LONG_RUN_HARDENING_REPORT.md)。
