# SmartHub Production / Long-running Hardening Report

日期：2026-08-01  
Repository：`steven87090799/unifi-smarthub`  
Branch：`fix/production-long-run-hardening`  
START_MAIN_SHA：`1f931756a1599eb2f239f998b8812edd75d15847`  
PR：[#7](https://github.com/steven87090799/unifi-smarthub/pull/7)，Draft／Open，target `main`
Hosted final-head gate：必須在目前 PR HEAD 上取得 PASS 才能 Ready／Merge；GitHub PR #7 checks 是 live source of truth。

## 結論

本次只在 current `origin/main` 上選擇性重作仍存在的 long-running hardening。Local tests、隔離 runtime smoke、fake-upstream short soak 與 Docker／CI 契約是可驗證證據；真實設備、正式 NAS deployment、獨立 DR restore 與 24／72 小時 soak 仍是 **NOT RUN**，不把它們寫成 PASS。

## 修復摘要

| Finding | Root cause | 修復 |
|---|---|---|
| Node 20 runtime baseline | Docker、CI、文件基線分裂，且 Node 20 已不符合本次要求 | Node 24.18.x、exact Docker patch digest、engines／`.nvmrc`／Dependabot 同步 |
| UniFi／NAS TLS | integration client 以 `rejectUnauthorized: false` 作預設 | 共用 strict TLS policy；verify default、private CA、explicit insecure warning、agent destroy/rebuild |
| SSH identity | UCG／Linux 未驗 host key，device pinning 不一致 | shared fingerprint policy；configured integration missing／mismatch fail closed；per-device diagnostics |
| Session recovery | cached controller cookie／CSRF 過期後沒有 bounded recovery | auth-specific invalidate、single-flight login、safe GET retry once；NoPermission／timeout 不誤重送 |
| Panel transport | HTTP 3000 與 forwarded headers 可能繞過 secure cookie／HTTPS policy | explicit HTTPS policy、trusted proxy allowlist、health-only local bypass、Secure／HttpOnly／SameSite 保留 |
| Long-term history | raw hard cap 會在 retention window 前先刪掉舊資料，tier crossing 只掃 raw | transactional raw→1m→5m→1h promotion、complete-bucket upsert/delete、delayed-cleanup query fallback、weighted numeric aggregation、null preservation |
| Telemetry emergency cap | global row cap 可能在 rollup 前直接刪除 raw telemetry | separate observable cap、complete raw bucket emergency downsample、no blind oldest-row deletion、per-device continuity |
| SQLite cleanup | 大批量同步清理可能長時間 block event loop | bounded batches、event-loop yield、coalesced cleanup、diagnostic counters |
| Backup memory | v1 whole-file + Base64 + JSON duplicated heap；v2 restore hash 仍可能整檔讀 DB | streaming backup v2、bounded 1 MiB synchronous DB hashing、manifest／SHA256／quick_check、staging、atomic replacement、rollback |
| Shutdown／SSE | upstream、SSE slow clients、pending jobs 沒有一致 drain boundary；capacity rejection 在 response 已開始後才發生 | explicit app grace、admission-before-headers、bounded writer／eviction、WAL checkpoint |
| UniFi relogin | retry headers 可殘留上一個 session 的 CSRF token | case-insensitive header rebuild；fresh token only；no stale token when login omits CSRF |
| Long-run evidence | runtime smoke 不能代表 soak | current-architecture `scripts/runtime-soak.js`，CI blocking 90 秒，30m／24h／72h separately NOT RUN |
| Operational visibility | process health 與 external dependency outage 混在一起 | authenticated `/health/operational`，freshness／failures／cooldown；container probe 不因外部 outage restart |
| Supply chain／containers | image tag、actions、SBOM／scan 證據不足 | Node/Docker/action pinning、Dependabot、OCI labels、pinned Trivy SBOM + HIGH/CRITICAL scan、no production `latest` |

## Local and hosted gates

最終 exact 結果以本分支 final rerun 為準，未執行項目不得填 PASS：

| Gate | Result | Evidence |
|---|---|---|
| `npm ci` | PASS | 282 packages installed; no `--force` |
| `npm run check:js` | PASS | 156 files |
| `npm test` | PASS | 605/605, 0 fail |
| `npm run check:css` | PASS | checked-in CSS |
| `npm audit --audit-level=low` | PASS | 0 vulnerabilities |
| `npm run test:smoke` | PASS | health／ready 200、CSRF／readonly 403、two SIGTERM exits 0 |
| `npm run test:soak` | PASS | 90,000 ms blocking CI-equivalent short soak |
| Compose config (default/profile) | PASS | both `config --quiet` |
| SmartHub／NAS Monitor Docker build | PASS | Node 24.18.0 Alpine exact digest |
| `npm run release:build` (isolated clean worktree) | PASS | clean detached worktree; user untracked file preserved |
| SBOM and HIGH/CRITICAL image scan | PASS | pinned Trivy digest; both images exit 0 |
| `git diff --check` | PASS | no whitespace errors |
| Hosted `SmartHub CI / Repository gate` | MUST PASS ON CURRENT PR HEAD | live result is tracked by GitHub PR #7; an older green SHA is not final-head evidence |

## Short soak evidence

The short soak uses only loopback fake Controller／NAS Monitor servers and does not touch real credentials or devices. The latest recorded CI-equivalent local run was:

| Metric | Value |
|---|---:|
| Duration | 90,000 ms |
| RSS start / peak / end | 94,453,760 / 112,279,552 / 112,246,784 bytes |
| Heap start / peak / end | 19,574,024 / 28,549,272 / 21,834,264 bytes |
| External start / peak / end | 4,027,744 / 13,375,314 / 8,482,372 bytes |
| Active handles peak | 13 |
| Active requests peak | 3 |
| Requests | 1,851 |
| SSE clients | 3 |
| Active upstream SSE at end | 0 |

This is evidence of bounded simulated behavior only. A 30-minute, 24-hour, or 72-hour staging soak is **NOT RUN**.

## Memory budget

The Compose main service remains at a 256 MiB limit because the available short-run evidence does not justify guessing a higher limit. The observed local RSS peak above is not a production guarantee; a real deployment must monitor steady state, backup peak, rollup cleanup, telemetry, reports, SSE clients and container OOM events before changing `SMARTHUB_MEM_LIMIT`.

## Backup and disaster recovery boundary

Backup v2 keeps database secrets out of ordinary export, validates SQLite and archive bounds, and stages restore before atomic replacement. Production operators must separately protect `config/.env` with the NAS encrypted backup mechanism. The backup destination must be a different storage mount or system; a second copy in the same Docker volume is not disaster recovery. An actual deployment backup and isolated restore drill are **NOT RUN**.

## Docker socket accepted risk

`nas-monitor` is disabled by default and isolated on an internal network. A process that obtains the Docker socket and is RCE'd may obtain high-privilege host control. Non-root, read-only rootfs, capability dropping, `no-new-privileges`, allowlists and resource limits reduce exposure but do not eliminate this risk. A `:ro` bind mount of the Docker socket is not a Docker Engine API read-only security boundary. This remains an accepted, explicitly documented risk when the profile is enabled.

## Old remote branch comparison

Counts are relative to `origin/main` at `1f931756…`; `ahead/behind` use `git rev-list --left-right --count origin/main...branch`. No old branch was merged or deleted.

| Remote branch | Tip SHA | Ahead | Behind | Useful capability | Decision |
|---|---|---:|---:|---|---|
| `origin/main` | `1f931756a159` | 0 | 0 | Current baseline | baseline |
| `origin/codex/docs-zh-cleanup-20260717` | `4270ada4a1bc` | 0 | 17 | Documentation consolidation | already integrated |
| `origin/codex/enrich-notification-reports` | `97cab47f0351` | 0 | 56 | Notification/report coverage | already integrated |
| `origin/codex/fix-smarthub-audit-findings` | `7dddbfceab82` | 0 | 5 | Prior security／CI hardening | already integrated |
| `origin/codex/integrate-unifi-device-telemetry` | `22edfba8871d` | 0 | 1 | Merged telemetry documentation | already integrated |
| `origin/codex/polling-cache-hardening` | `1f4429053085` | 3 | 14 | Rollup、yielding cleanup、SSE、soak concepts | selectively ported; no whole merge/cherry-pick |
| `origin/codex/production-final-hardening` | `1a6d53b470da` | 0 | 44 | Earlier SQLite/runtime architecture | superseded/already integrated |
| `origin/codex/unifi-device-telemetry` | `9af92b28d9d7` | 8 | 14 | Historical device telemetry implementation | historical reference only; no whole merge |
| `origin/codex/ups-live-sag-polling` | `eeb48547b93f` | 0 | 15 | UPS live polling | already integrated |
| `origin/feature/sqlite-migration` | `f6b9bf8cd315` | 0 | 108 | SQLite migration history | already integrated |
| `origin/feature/ui-ux-redesign` | `22d989205288` | 0 | 73 | UI／chart design | already integrated |
| `origin/feature/wiim-integration` | `88e9e3dee366` | 0 | 110 | WiiM integration | already integrated |
| `origin/hotfix/unified-chart-reveal` | `0e47ce5a2aab` | 0 | 59 | Chart reveal hotfix | already integrated |
| `origin/production-hardening-final` | `fb32e2b5ee15` | 0 | 21 | Chinese production docs | already integrated |

The two branches explicitly called out by the request were treated as references only. Their useful ideas were reimplemented against current `main` contracts and covered by current tests.

## Real-device and long-run status

All of the following remain **NOT RUN**: real UniFi／NAS／UPS／AdGuard／Linux／WiiM connections; real telemetry; Device SSH authentication and thermal command; host-key verification against real devices; controller reboot; NAS JWT refresh; real notifications; controlled PoE／block writes; actual deployment backup／restore; Docker socket mutation; and minimum 24-hour／preferred 72-hour staging soak.

## Delivery status

PR #7 is the single Draft PR for this work and targets `main`; it must remain Draft and unmerged. The branch is pushed normally. Before Ready or Merge, inspect the live PR checks and require `SmartHub CI / Repository gate` to be PASS on the exact current PR HEAD. The previous green result for an older SHA is historical evidence only.
