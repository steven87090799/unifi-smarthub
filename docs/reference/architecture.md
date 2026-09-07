# SmartHub 目前架構

## 組成

| 區域 | 實作 |
|---|---|
| 正式後端 | `server.js` 組裝 Express、整合、排程與生命週期 |
| 可測試邊界 | `server/` 內的 middleware、routes、policies、services、jobs、integrations、storage |
| 前端 | `public/index.html` SPA shell，加上獨立登入與 Web Push 模組 |
| 假資料 | `server-mock.js`，維持前端可見契約 |
| 儲存 | `db.js` + `better-sqlite3`，WAL、retention、backup／restore |
| 診斷 | `observability/`，結構化 log、issue、task、resource 與 health |
| 部署 | SmartHub 主容器；可選的 `nas-monitor` profile |

## 信任邊界

- 瀏覽器只呼叫 SmartHub，同源資產與 API 不直接暴露上游 credential。
- 面板使用 Session／相容 Basic Auth、admin／readonly 角色、Origin、CSRF 與輸入政策。
- WiiM、Docker、UniFi 威脅封鎖、AdGuard 政策等異動都由伺服器端 allowlist／policy 決定。
- NAS Monitor API key 只送往經驗證的固定 origin；Docker mutation 與 log 各用獨立 allowlist。
- UniFi Device SSH 使用最多 32 個 MAC allowlist、Controller-known identity、Literal IP、固定唯讀命令、最多兩個 worker 與可選 SHA256 Host Key pinning；credential、allowlist 與 fingerprint 不跨出後端。
- 部署與連線設定的權威是 `config/.env`；可調整的面板設定（例如輪詢）持久化於 `DATA_DIR/app-settings.json`，以暫存、fsync 與 atomic rename 寫入。

## 資料與工作

- SQLite 保存歷史、事件、報表 claims、政策、Web Push、audit 與 instance lock。
- 一般歷史先進入有上限佇列，再批次寫入；查詢會合併未落盤資料。
- UniFi 裝置遙測以專用 snapshot 隔開 HTTP refresh 與真實收集；sampler 才能查 Controller／SSH、以 transaction 寫入有 retention／hard cap 的 `unifi_device_telemetry`。失敗保留最後成功資料但標為 stale，stale／offline 溫度不入庫。
- 同名週期工作避免重入；報表另以 SQLite claim、lease、retry 與 fencing 保護。
- DATA_DIR 由租約鎖保證單一 owner；失去 owner 時採安全關閉。
- SIGTERM 會停止領取新工作、flush／close 資源並在 Compose grace period 內退出。

## 更新模型

- 前端以 `/api/heartbeat` 維持活動 scope。
- 前端只輪詢目前頁面。一般裝置更新與對應後端取樣預設為 5 秒；UPS 狀態獨立預設為 3 秒，兩者都可在設定頁調整。
- 切頁、背景分頁或租約到期後回到低頻。
- UniFi 裝置遙測使用獨立 `unifi-device-telemetry` scope（預設可見 60 秒、閒置 300 秒），不會加速 UCG 舊歷史、UPS、NAS 或 WiiM sampler。
- UPS 狀態與斷電事件取樣不依賴瀏覽器是否開啟。

## 發布模型

- `SmartHub CI` 是 required-check candidate；成功後 `Publish SmartHub images` 從同一個 exact CI head 建立並發布 GHCR 的 SmartHub／NAS Monitor 成對 multi-arch 映像。
- GHCR 同時保留 `sha-<commit>` tag；`main` 另發布 `stable`，`vX.Y.Z` tag 則在 exact CI head 成功後發布固定版本 tag。private package 由 GitHub Actions `GITHUB_TOKEN` 發布，NAS 以最小權限 `read:packages` PAT 拉取。
- 兩個映像必須具有一致 version、revision、created 與 clean identity。
- NAS runtime Compose 不含 `build:`；`docker-compose.build.yml` 僅供本機／CI source build。正式部署使用 `scripts/update-nas.sh` 先 pull、再 offline preflight、最後以 `--no-build --pull never` recreate。高保證部署使用成對 registry digest。
- runtime SQLite 與 JSON 狀態留在 named volume `/app/data`，`config/.env` 留在獨立 bind mount；更新腳本會在 recreate 前後比對 `/app/data` volume identity，避免 project／目錄變更時誤用空 volume。
- 完整流程見 `operations/PRODUCTION-RELEASE-CHECKLIST.md`。

## 修改原則

- 新 API 優先放入可測試 route／policy／service，而不是持續擴大 `server.js`。
- 前端逐功能抽離，但先保護 navigation、polling、visibility lease、chart 與 write controls。
- 前端可見契約同步更新 production、mock 與測試。
- 本文件不列完整 endpoint；後端與前端權威索引分別是 [backend-map.md](backend-map.md) 與 [frontend-map.md](frontend-map.md)。
