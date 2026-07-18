# UGREEN NAS 整合摘要

SmartHub 可直接讀取 UGOS Pro，也可選配 NAS Monitor。此文件描述目前程式行為，不是完整 UGOS API 手冊。

## 直接 UGOS

```env
NAS_HOST=192.168.1.50
NAS_PORT=9443
NAS_SCHEME=https
NAS_USER=monitor
NAS_PASSWORD=...
```

目前登入流程：

1. 優先 `POST /ugreen/v1/verify/check?token=`，從 `x-rsa-token` 取得公鑰。
2. 失敗時回退 `GET /ugreen/v1/verify/rsa_public_key`。
3. 以 RSA PKCS1 v1.5 加密密碼，再 `POST /ugreen/v1/verify/login`。
4. token 保守快取 12 小時；UGOS body code 顯示失效時重新登入一次。

主要讀取：

- `/ugreen/v1/taskmgr/stat/get_all`
- `/ugreen/v1/storage/disk/list`
- `/ugreen/v1/storage/volume/list`
- UGOS logs 與 UPS 狀態相關路徑

UGOS 回應巢狀結構可能漂移，解析器以有界深度尋找欄位。直接連線目前接受設備自簽憑證，因此只應用於可信內網；若要強化 TLS，需同步補設定、錯誤契約與測試。

## 歷史

UGOS 主要提供即時快照，SmartHub 自行取樣 CPU、記憶體、溫度、風扇、流量、硬碟與容量並寫入 SQLite：

- NAS 頁活動時約 3 秒。
- 閒置時約 15 分鐘。
- 休眠硬碟溫度記為 `null`，避免為量測喚醒硬碟。
- 保存天數由應用設定控制。

## NAS Monitor

內建模式：

```env
NAS_MONITOR_URL=http://nas-monitor:8000
NAS_MONITOR_API_KEY=...
NAS_MONITOR_MODE=docker_only
```

- `docker_only`：只提供容器 inventory、metrics、logs 與受限 actions；NAS 歷史仍用 UGOS 取樣。
- `full`：只有外部 monitor 實作完整 history、alerts、SSE 時才使用。
- monitor 未設定或失敗時回誠實空狀態，不以假資料冒充正式來源。
- URL、key、mode 是 recreate-scoped 信任組；變更後需協調重建。

安全設定與部署見 [NAS Docker 管理指南](../operations/NAS-DOCKER-MONITOR-SETUP.md)。

## SmartHub 路由

- `/api/nas/overview`, `/disks`, `/disk-smart`, `/logs`, `/volumes`, `/ups`
- `/api/nas/*-history`, `/storage-forecast`, `/downtime`
- `/api/nas/docker*`, `/alerts*`, `/stream`

變更前先查 `SERVER-MAP.md` 與 `server/integrations/nas-monitor-client.js`，並保持 production／mock 契約一致。
