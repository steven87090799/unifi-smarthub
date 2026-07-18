# SmartHub 工程待辦

只列尚未完成、且不阻擋目前受控部署的工作。已修復項目見 [生產就緒報告](../reports/PRODUCTION_READINESS_REPORT.md)。

## 架構

- [ ] 依 contract coverage 逐步抽出 UniFi、NAS、WiiM、UPS clients 與 recurring jobs。
- [ ] 在 `public/js/web-push.js` 之後，逐頁抽出 polling／API 模組；先保護 navigation、visibility lease、charts 與 write controls。
- [ ] 減少 `server-mock.js` route assembly 重複，但維持 production／mock parity。

## 部署驗證

- [ ] 在目標主機做長期 RSS、CPU、restart、volume 與 log 趨勢監控。
- [ ] 若發布到 registry，驗證 paired push、immutable digest、clean-host pull 與 digest rollback。
- [ ] 取得明確授權後，再對真實 UniFi、NAS Docker、WiiM、PoE 或 AdGuard 做 mutation smoke。
- [ ] 在真實 PPB／NUT、NAS、UniFi、AdGuard、Web Push endpoint 驗證網路、憑證、權限與 rate limit。

產品候選見 [ROADMAP.md](ROADMAP.md)。任何新能力都要重新通過 [正式發布檢查清單](../operations/PRODUCTION-RELEASE-CHECKLIST.md)。
