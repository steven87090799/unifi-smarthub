# SmartHub Production Acceptance

本文件是 `fix/production-long-run-hardening` 的驗收矩陣。它區分本機程式證據、隔離 runtime 證據、hosted CI、真實設備與長期 soak；mock、smoke 或 short soak 不得代替真實設備或 24／72 小時觀察。

## 交付識別

| 項目 | 值 |
|---|---|
| Repository | `steven87090799/unifi-smarthub` |
| Branch | `fix/production-long-run-hardening` |
| START_MAIN_SHA | `1f931756a1599eb2f239f998b8812edd75d15847` |
| PR | [#7](https://github.com/steven87090799/unifi-smarthub/pull/7)，Draft／Open，target `main` |
| Hosted final-head gate | 必須在目前 PR HEAD 上 PASS；GitHub PR #7 checks 是 live source of truth |
| Runtime baseline | Node.js `24.18.x`；Docker base image exact patch + digest |

## Gate A - Repository

| Check | 結果 | 證據／限制 |
|---|---|---|
| Node 24 supported runtime | PASS | `.nvmrc`、`package.json engines`、Dockerfile、CI 同步 |
| `npm ci` | PASS | 282 packages；不使用 `--force` |
| `npm run check:js` | PASS | 156 files |
| `npm test` | PASS | 605/605，0 fail |
| `npm run check:css` | PASS | checked-in CSS gate |
| `npm audit --audit-level=low` | PASS | 0 vulnerabilities |
| `npm run test:smoke` | PASS | 正式 `server.js` 的隔離登入、CSRF、SIGTERM、restart |
| `npm run test:soak` | PASS | CI blocking 90 秒；非多日證據 |
| Compose profiles | PASS | default 與 `nas-monitor` `config --quiet` |
| Docker builds | PASS | SmartHub 與 NAS Monitor image |
| `npm run release:build` | PASS | isolated clean detached worktree；原工作樹未追蹤檔保持 untouched |
| SBOM／container scan | PASS | pinned Trivy digest；HIGH／CRITICAL scan exit 0 |
| `git diff --check` | PASS | no whitespace errors |
| Hosted `SmartHub CI / Repository gate` | MUST PASS ON CURRENT PR HEAD | older green SHA is not final-head evidence |

## Gate B - Persistence and DR

| Check | 結果 | 證據／限制 |
|---|---|---|
| Existing SQLite migration compatibility | PASS | migration idempotency 與 `quick_check` |
| Time-advancing tier promotion | PASS | explicit clock verifies raw→1m→5m→1h、expiry、weighted sample_count、null truth and API continuity |
| Telemetry emergency cap | PASS | tiny-cap regression downsamples complete buckets before raw deletion and keeps devices/history visible |
| Rollup idempotency | PASS | repeated cleanup 不重複平均造成 drift |
| Bounded long-range API output | PASS | resolution 與 point budget 明確 |
| Backup larger than old 43 MiB limit | PASS | streaming v2、manifest SHA256、size cap |
| Restore／truncated／checksum mismatch | PASS | staging、驗證、atomic replacement |
| Interrupted restore rollback | PASS | staged restore 不破壞原 DB |
| Secret DR procedure | DOCUMENTED | `config/.env` 需獨立加密備份；同一 volume 不算 DR |
| Actual deployment backup／isolated restore drill | NOT RUN | 需要正式 NAS、維護窗與獨立 storage mount |

## Gate C - Security

| Check | 結果 | 證據／限制 |
|---|---|---|
| UniFi self-signed without CA rejected | PASS | 本機 HTTPS server |
| UniFi private CA accepted | PASS | explicit CA file |
| NAS self-signed without CA rejected | PASS | 共用 strict TLS policy |
| NAS private CA accepted | PASS | agent reuse／destroy |
| Explicit insecure opt-in only | PASS | default verify；malformed config rejected |
| UCG／Linux SSH host key match and mismatch | PASS | missing pin fails closed |
| Device SSH per-device host key policy | PASS | target-specific missing／mismatch |
| Production panel HTTP rejected | PASS | health probe bypass is narrow |
| Trusted reverse proxy HTTPS accepted | PASS | trusted proxy source required |
| Spoofed forwarded headers rejected | PASS | untrusted `X-Forwarded-Proto` ignored |
| Readonly mutation denied／CSRF enforced | PASS | existing route contracts retained |

## Gate D - Lifecycle and operations

| Check | 結果 | 證據／限制 |
|---|---|---|
| Controller session invalidation and relogin | PASS | bounded single-flight retry；case-insensitive stale CSRF removal |
| Upstream timeout safety | PASS | destructive mutation not blindly replayed |
| Settings hot rebuild | PASS | agents and session token invalidated |
| SSE slow client and cleanup | PASS | admission-before-headers、clean max-client 503、bounded writer、drain timeout、eviction |
| SIGTERM／restart／SQLite checkpoint | PASS | app grace < Compose grace |
| Operational health endpoint | PASS | authenticated dependency freshness; no restart loop |
| Short runtime soak | PASS | simulated local dependencies only |
| 30-minute staging soak | NOT RUN | not executed in this delivery |
| 24-hour staging soak | NOT RUN | not executed in this delivery |
| 72-hour preferred soak | NOT RUN | not executed in this delivery |

## Gate E - Real hardware

以下項目全部是 **NOT RUN**，不能由 mock、unit test、runtime smoke 或 short soak 代替：

- Real UniFi Controller read-only validation and telemetry fields
- Real Device SSH auth、host-key verification、thermal command
- Controller reboot recovery
- Real NAS login／JWT refresh、NAS Monitor recovery
- Real UPS／AdGuard／Linux／WiiM sampling and notification delivery
- Controlled PoE／block／unblock writes
- Backup from actual deployment and isolated restore
- Minimum 24-hour staging soak; preferably 72 hours

## Release decision

本分支的 local gates 已完成；PR #7 維持 Draft、target `main`、不自動 merge。Ready／Merge 前必須確認 GitHub PR #7 的 `Repository gate` 在目前 exact HEAD 上 PASS；在 Gate E 或 24／72 小時 soak 完成前，不宣稱「已由真實部署證明 fully production-ready」。
