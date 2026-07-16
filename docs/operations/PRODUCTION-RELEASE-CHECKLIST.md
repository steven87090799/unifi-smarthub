# SmartHub 正式發布檢查清單

所有命令從 repository root 執行。`config/.env` 只存在部署主機，不可提交或輸出展開後的 Compose config。

## 1. 前置條件

- 預定發布 commit 的 `git status --short` 無輸出。
- `config/` 權限 `0700`、`config/.env` 權限 `0600`，container UID 1000 可在目錄內建立、fsync、rename。
- 根目錄沒有第二份 `.env`；所有 Compose 指令使用同一個 `--env-file config/.env`。
- 已設定 `PANEL_PASSWORD`；唯讀密碼不得等於管理員密碼。
- 容器內 upstream 位址不是 `localhost`／`127.0.0.1`。
- Docker UPS 使用 `UPS_SOURCE=ppb`、`host.docker.internal:3052`，或容器可達的 NUT server。
- 已完成安全備份；需要完整離線備份時先停止服務並保存 DB／WAL／SHM。
- 只有需要 Docker 管理時才啟用 `nas-monitor` profile。

## 2. 程式庫檢查

正式 release 執行完整 gate：

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

任何失敗先保存第一個證據並找 root cause，不要只重跑到綠燈。Critical／High audit finding 不得無說明放行。

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
