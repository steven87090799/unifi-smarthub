# SmartHub Remaining Engineering Backlog

本文件只列 hardening 後仍未宣稱完成的非阻擋工作。已修復問題與實際驗證結果不在此重複；以 `PRODUCTION_READINESS_REPORT.md`（完成後）、repository tests 與 commit history 為準。

## 漸進式架構拆分

- [ ] 依 contract-test coverage，逐一把 UniFi、NAS、WiiM、UPS clients 與 recurring jobs 從 `server.js` 抽出；每次 extraction 必須有可量測的 ownership/testability 收益。
- [ ] 在現有 `public/js/web-push.js` 邊界之後，逐一抽出 polling/API 或單一頁面 feature；先保護 navigation、visibility lease、charts、error/empty state 與 write controls。
- [ ] 減少 `server-mock.js` 的重複 route assembly，但不得犧牲 production/mock contract parity 或讓 mock 取得 production secret/side effect。

## 需要部署環境或外部授權的驗證

- [ ] 在實際目標主機執行長時間 resource/volume/log 趨勢監控；短時間 accelerated cycles 不是 365 天證明。
- [ ] 若要發布到 registry，驗證 paired push、immutable digest、pull-from-clean-host 與 digest-based rollback；repository 的 `release:build` 目前只建立本機 image/tag。
- [ ] 只有取得明確 destructive authorization 後，才對真實 UniFi、NAS Docker、WiiM、PoE 或 AdGuard mutation 執行 production smoke test。
- [ ] 在真正的 PPB/NUT、NAS、UniFi、AdGuard 與 Web Push endpoint 驗證部署網路、憑證/CA、權限與 rate-limit policy；本機 failure injection 不取代外部 compatibility test。

## Product backlog

未實作功能與安全邊界請見 `ROADMAP.md`。任何新 capability 都必須重新通過 `PRODUCTION-RELEASE-CHECKLIST.md`，不得把本清單當成已完成驗證的證據。
