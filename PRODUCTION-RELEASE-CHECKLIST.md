# SmartHub Production Release Checklist

這份清單是正式 Docker release 的執行契約。所有命令都從 repository root 執行；`config/.env` 只存在部署主機，不可提交或輸出展開後的 Compose config。

## 1. Release 前置條件

- 使用預定發布 commit，且 `git status --short` 必須沒有輸出。
- `config/` 是部署實例專用目錄；目錄權限 `0700`、`config/.env` 權限 `0600`，container UID 1000 能在目錄內建立、`fsync`、rename 檔案。
- 根目錄沒有第二份 `.env`；所有 Compose 命令使用同一個 `--env-file config/.env`，`SMARTHUB_CONFIG_DIR` 指向該檔案所在目錄。
- `PANEL_PASSWORD` 已設定；若啟用唯讀登入，`PANEL_READONLY_PASSWORD` 不得與管理員密碼相同。
- 容器內使用的 upstream 位址不是 `localhost` / `127.0.0.1`。Docker UPS 使用已驗證的 `UPS_SOURCE=ppb`、`PPB_HOST=host.docker.internal`、`PPB_PORT=3052`，或一個容器可達的 NUT server。
- 上線前完成安全備份；需完整離線備份時先停止服務並保留 SQLite 的 DB/WAL/SHM。設定頁匯出的安全備份不包含 secret。
- 只有確實需要 Docker 管理或 log 讀取時才啟用 `nas-monitor` profile；socket 寫入能力等同宿主機 root 權限。mutation 與 log access 分別使用明確 allowlist，SmartHub 自身容器保持 protected。

## 2. Repository gates

在 clean checkout 安裝 lockfile 的確切依賴，然後執行完整 gate：

```bash
npm ci
npm test
npm audit --audit-level=high
npm run check:css
git ls-files -z '*.js' | xargs -0 -n1 node --check
git diff --check
docker compose --env-file config/.env config --quiet
docker compose --env-file config/.env --profile nas-monitor config --quiet
```

安全、授權、Docker broker、restart/recreate 與 release contract 的快速失敗定位組：

```bash
node --test \
  test/panel-security.test.js \
  test/write-input-policy.test.js \
  test/write-route-contract.test.js \
  test/docker-action-policy.test.js \
  test/nas-monitor-client.test.js \
  test/nas-monitor-sse.test.js \
  test/nas-monitor.test.js \
  test/config-restart.test.js \
  test/frontend-connection-restart.test.js \
  test/deployment-contract.test.js \
  test/release-build.test.js
```

任何失敗都必須先保存第一個失敗證據並找出 root cause；不可只重跑到綠燈。`npm audit` 的結果需依可達性與相容性判讀，但 Critical/High 漏洞不得無說明放行。

## 3. Immutable paired-image transaction

不要以 dirty checkout、`latest` 或 release 指令中的 `--build` 部署。執行：

```bash
npm run release:build
```

此命令會：

1. 拒絕 staged、unstaged 或 untracked 差異。
2. 從 `git archive HEAD` 建立乾淨 source tree。
3. 建置並驗證 SmartHub 與 NAS Monitor 的 version/revision/created/dirty OCI identity。
4. 在兩個 staging image 都成功後才成對發布 revision tags。
5. 拒絕重指既有 revision tag；第二個 tag 失敗時回滾第一個新 tag。

保存最後一行 JSON 的 `revision`、兩個 `images` 與 `image_ids`。將確切 revision tag 寫入部署主機的 `config/.env`：

```dotenv
SMARTHUB_IMAGE=unifi-smarthub:<12-char-revision>
NAS_MONITOR_IMAGE=unifi-smarthub-nas-monitor:<12-char-revision>
```

本機 tag 與 image ID 是本機 rehearsal 證據，不等同 registry digest。若另有 registry 發布流程，必須成對 push、記錄兩個 immutable digest，且 Compose 最終引用 digest 或不可變 tag；本 repository 的 `release:build` 不會 push。

## 4. Isolated rehearsal and production start

先以獨立 Compose project、獨立 config 目錄與獨立 volume rehearsal；不得連到或修改真正設備。未啟用 monitor：

```bash
docker compose --env-file config/.env -p smarthub-prod up -d --no-build --pull never
```

啟用 monitor：

```bash
docker compose --env-file config/.env -p smarthub-prod --profile nas-monitor \
  up -d --no-build --pull never
```

確認實際執行的是 release JSON 中的兩個 image ID，且 `/health` 的 revision、version、created、dirty 與 image label 完全一致。普通開發 image 的 identity 會是 incomplete，不可放行。

```bash
docker compose --env-file config/.env -p smarthub-prod ps
BASE_URL=http://127.0.0.1:3000 # 改成實際 published host port
curl -fsS "$BASE_URL/health"
curl -fsS "$BASE_URL/health/ready"
read -rs PANEL_PASSWORD
curl -fsS -u "admin:${PANEL_PASSWORD}" "$BASE_URL/api/system/status"
unset PANEL_PASSWORD
```

驗收至少包含：

- 未驗證請求被拒絕、readonly 可讀但所有 write route 被拒絕、admin write 仍需有效 same-origin/CSRF proof。
- Monitor credential 只送往 canonical configured origin；redirect/proxy 不得轉送 credential。Docker log 需 admin 且同時符合獨立 log allowlist；mutation 需 admin、confirmation、全域 enable 與獨立 action allowlist。
- 預設不啟用 monitor 時，SmartHub readiness 不依賴 monitor。啟用後 monitor source 錯誤仍不得把主服務誤判為未 ready。
- 以 rehearsal 資料修改一個非機密設定，普通 restart 後仍存在；recreate-scoped `NAS_MONITOR_URL` / `NAS_MONITOR_API_KEY` / `NAS_MONITOR_MODE` 必須以同一 transaction 協調重建，pending state 在完成後清除。
- 執行 container restart 與 force-recreate；確認排程不重複、SQLite `quick_check` 成功、staged restore 與 config authority 沒有分裂。
- 送出 SIGTERM；確認 20 秒 grace period 內停止、背景工作停止領取新任務、可安全 flush/close，重啟後 `/health/ready` 回復。
- 檢查 diagnostics、Docker log 與 Active Issues 能區分 dependency failure、worker stuck、DB failure及 recovery；確認 log 不含 Authorization、cookie、password、API key、CSRF token 或 webhook。

外部整合的 401/403/404/429/500、timeout、connection refused、malformed/empty response 應使用 mock/failure injection 驗證。真正的 UniFi、NAS、WiiM、AdGuard、UPS 或 Docker mutation 需要另行明確授權。

## 5. Rollback

發布前保留上一組已驗證的 SmartHub/NAS Monitor immutable tag 或 digest。Rollback 必須成對回退：

1. 將 `SMARTHUB_IMAGE` 與 `NAS_MONITOR_IMAGE` 同時改回上一組 identity。
2. 以相同 project、config dir、env file 與 profile 執行 `up -d --no-build --pull never`。
3. 重跑 liveness、readiness、diagnostics、登入角色、SQLite 與重要整合 smoke checks。
4. 若存在 staged restore，先依設定頁狀態判斷；不要在未知 restore transaction 中直接替換 volume。

不要刪除或重指已發布 revision tag，也不要以 `docker compose down -v` 作正式 rollback；`-v` 會刪除持久資料。

## 6. Release record

每次 release 記錄：Git commit、兩個 image tag/digest/ID、Compose project、config authority、profile、測試與 audit 結果、rehearsal 時間、健康/重啟/SIGTERM/SQLite 結果、已執行的 failure injection、未執行或外部阻擋項目、rollback identity，以及操作者。短時間加速測試只能證明被測 cycles 的界限與趨勢，不可宣稱證明 365 天無故障。
